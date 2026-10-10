"""End-to-end tests: real headless Firefox + the packed extension."""
import functools
import http.server
import json
import os
import socketserver
import tempfile
import threading
import time
import unittest
import zipfile

from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "tests", "site")
EXT_UUID = "5d3e0a1c-7b3f-4f8e-9d52-2a4c1b6e7f90"
CHARS = "asdfghjklqwertyuiopzxcvbnm"


def gen_labels(n, chars=CHARS):
    q = [""]
    while len(q) < max(n, 2):
        h = q.pop(0)
        q.extend(h + c for c in chars)
    return q[:n]


def build_xpi(dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(ROOT, "manifest.json"), "manifest.json")
        for name in os.listdir(os.path.join(ROOT, "src")):
            z.write(os.path.join(ROOT, "src", name), f"src/{name}")


def wait(cond, timeout=6.0, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = cond()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return cond()


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class KeyhopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(Quiet, directory=SITE)
        cls.httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.port}"

        cls.tmp = tempfile.mkdtemp(prefix="keyhop-test-")
        xpi = os.path.join(cls.tmp, "keyhop.xpi")
        build_xpi(xpi)

        o = Options()
        o.add_argument("-headless")
        o.add_argument("--width=1200")
        o.add_argument("--height=800")
        o.set_preference("extensions.webextensions.uuids", json.dumps({"keyhop@uttam.local": EXT_UUID}))
        o.set_preference("xpinstall.signatures.required", False)
        # test-only: privileged context is how the options page gets opened (see save_options)
        cls.driver = webdriver.Firefox(options=o, service=Service(service_args=["--allow-system-access"]))
        cls.driver.install_addon(xpi, temporary=True)
        cls.main = cls.driver.current_window_handle

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        cls.httpd.shutdown()

    # -------------------------------------------------------------- helpers
    def setUp(self):
        d = self.driver
        for h in list(d.window_handles):
            if h != self.main:
                d.switch_to.window(h)
                d.close()
        d.switch_to.window(self.main)
        self.save_options({"excluded": [], "hintChars": CHARS, "newTabActive": False})
        self.open("index.html")

    def open(self, page):
        self.driver.get(f"{self.base}/{page}")
        wait(lambda: self.driver.execute_script("return document.readyState") == "complete")
        time.sleep(0.5)  # content script + options load

    def press(self, *keys):
        ActionChains(self.driver).send_keys(*keys).perform()

    def js(self, script, *args):
        return self.driver.execute_script(script, *args)

    def scroll_y(self):
        return self.js("return Math.round(window.scrollY)")

    def host_attr(self, name):
        return self.js("var h=document.getElementById('keyhop-root');return h?h.dataset[arguments[0]]:null", name)

    def save_options(self, values):
        """Fill in the real options page (WebDriver can't navigate to moz-extension:// itself,
        so the tab is opened from Firefox's privileged context)."""
        d = self.driver
        before = set(d.window_handles)
        d.set_context("chrome")
        d.execute_script(
            "const t = window.gBrowser.addTab(arguments[0], {triggeringPrincipal:"
            " Services.scriptSecurityManager.getSystemPrincipal()});"
            " window.gBrowser.selectedTab = t;",
            f"moz-extension://{EXT_UUID}/src/options.html",
        )
        d.set_context("content")
        new = wait(lambda: [h for h in d.window_handles if h not in before])
        d.switch_to.window(new[0])
        wait(lambda: d.find_element(By.ID, "save"))
        d.find_element(By.ID, "excluded").clear()
        d.find_element(By.ID, "excluded").send_keys("\n".join(values.get("excluded", [])))
        d.find_element(By.ID, "hintChars").clear()
        d.find_element(By.ID, "hintChars").send_keys(values.get("hintChars", CHARS))
        box = d.find_element(By.ID, "newTabActive")
        if box.is_selected() != bool(values.get("newTabActive")):
            box.click()
        d.find_element(By.ID, "save").click()
        wait(lambda: d.find_element(By.ID, "status").text == "Saved")
        d.close()
        d.switch_to.window(self.main)
        time.sleep(0.2)

    # ---------------------------------------------------------------- tests
    def test_scrolling_keys(self):
        self.assertEqual(self.scroll_y(), 0)
        self.press("j")
        self.assertTrue(wait(lambda: self.scroll_y() == 80), f"j -> {self.scroll_y()}")
        self.press("k")
        self.assertTrue(wait(lambda: self.scroll_y() == 0))
        self.press("5", "j")
        self.assertTrue(wait(lambda: self.scroll_y() == 400), f"5j -> {self.scroll_y()}")
        self.press("G")
        self.assertTrue(wait(lambda: self.scroll_y() > 2500), f"G -> {self.scroll_y()}")
        self.press("g", "g")
        self.assertTrue(wait(lambda: self.scroll_y() == 0), f"gg -> {self.scroll_y()}")
        half = round(self.js("return window.innerHeight") / 2)
        self.press("d")
        self.assertTrue(wait(lambda: abs(self.scroll_y() - half) <= 2), f"d -> {self.scroll_y()} (want {half})")
        self.press("u")
        self.assertTrue(wait(lambda: self.scroll_y() == 0), f"u -> {self.scroll_y()}")

    def test_keys_pass_through_in_text_fields(self):
        field = self.driver.find_element(By.ID, "field")
        field.click()
        self.press("jjj")
        self.assertEqual(field.get_attribute("value"), "jjj")
        self.assertEqual(self.scroll_y(), 0)
        self.press(Keys.ESCAPE)  # blurs the field
        self.press("j")
        self.assertTrue(wait(lambda: self.scroll_y() == 80), "j should scroll again after Esc")

    def test_unmapped_keys_reach_the_page_mapped_do_not(self):
        self.press("z")
        self.press("j")
        keys = self.js("return window.__keys")
        self.assertIn("z", keys)
        self.assertNotIn("j", keys)

    def test_insert_mode(self):
        self.press("i")
        self.assertTrue(wait(lambda: self.host_attr("mode") == "insert"))
        self.press("j")
        time.sleep(0.3)
        self.assertEqual(self.scroll_y(), 0)
        self.assertIn("j", self.js("return window.__keys"))
        self.press(Keys.ESCAPE)
        self.assertTrue(wait(lambda: self.host_attr("mode") == "normal"))

    def test_hints_count_and_click(self):
        self.press("f")
        self.assertTrue(wait(lambda: self.host_attr("mode") == "hints"))
        # 6 links + text input + textarea + button are on screen; the bottom link is not
        self.assertEqual(self.host_attr("count"), "9")
        labels = gen_labels(9)
        self.press(labels[2])  # third target in document order: link "Three"
        self.assertTrue(wait(lambda: self.js("return location.hash") == "#three"))
        self.assertTrue(wait(lambda: self.host_attr("mode") == "normal"))

    def test_hints_escape_cancels(self):
        self.press("f")
        self.assertTrue(wait(lambda: self.host_attr("mode") == "hints"))
        self.press(Keys.ESCAPE)
        self.assertTrue(wait(lambda: self.host_attr("mode") == "normal"))
        self.assertEqual(self.host_attr("count"), "0")

    def test_hint_focuses_text_input_then_typing_goes_to_field(self):
        self.press("f")
        wait(lambda: self.host_attr("mode") == "hints")
        self.press(gen_labels(9)[6])  # the text input
        self.assertTrue(wait(lambda: self.js("return document.activeElement.id") == "field"))
        self.press("hello")
        self.assertEqual(self.driver.find_element(By.ID, "field").get_attribute("value"), "hello")

    def test_F_opens_link_in_new_background_tab(self):
        d = self.driver
        self.press("F")
        wait(lambda: self.host_attr("mode") == "hints")
        self.press(gen_labels(9)[5])  # "Page two"
        self.assertTrue(wait(lambda: len(d.window_handles) == 2), "new tab should open")
        new = [h for h in d.window_handles if h != self.main][0]
        d.switch_to.window(new)
        self.assertTrue(wait(lambda: d.current_url.endswith("/page2.html")), d.current_url)
        d.switch_to.window(self.main)
        self.assertEqual(self.js("return document.visibilityState"), "visible",
                         "original tab should keep focus (newTabActive=false)")

    def test_tab_switch_and_close(self):
        d = self.driver
        self.press("F")
        wait(lambda: self.host_attr("mode") == "hints")
        self.press(gen_labels(9)[5])
        wait(lambda: len(d.window_handles) == 2)
        new = [h for h in d.window_handles if h != self.main][0]
        time.sleep(0.8)
        self.press("K")  # next tab
        d.switch_to.window(new)
        self.assertTrue(wait(lambda: self.js("return document.visibilityState") == "visible"),
                        "K should activate the next tab")
        self.press("J")  # previous tab -> back to main
        d.switch_to.window(self.main)
        self.assertTrue(wait(lambda: self.js("return document.visibilityState") == "visible"))
        # activate the new tab again, then close it with x
        self.press("K")
        d.switch_to.window(new)
        wait(lambda: self.js("return document.visibilityState") == "visible")
        time.sleep(0.4)
        self.press("x")
        self.assertTrue(wait(lambda: len(d.window_handles) == 1), "x should close the tab")

    def test_command_bar_opens_url(self):
        self.press("o")
        self.assertTrue(wait(lambda: self.host_attr("mode") == "omni"))
        self.press(f"{self.base}/page2.html", Keys.ENTER)
        self.assertTrue(wait(lambda: self.driver.current_url.endswith("/page2.html")), self.driver.current_url)

    def test_command_bar_does_not_leak_keys_to_page(self):
        self.press("o")
        wait(lambda: self.host_attr("mode") == "omni")
        self.press("xyz")
        self.assertEqual(self.js("return window.__keys.filter(k=>'xyz'.includes(k)).length"), 0)
        self.press(Keys.ESCAPE)
        self.assertTrue(wait(lambda: self.host_attr("mode") == "normal"))

    def test_help_overlay(self):
        self.press("?")
        self.assertTrue(wait(lambda: self.host_attr("mode") == "help"))
        self.press(Keys.ESCAPE)
        self.assertTrue(wait(lambda: self.host_attr("mode") == "normal"))

    def test_history_back(self):
        self.driver.find_element(By.ID, "p2").click()
        wait(lambda: self.driver.current_url.endswith("page2.html"))
        time.sleep(0.5)
        self.press("H")
        self.assertTrue(wait(lambda: self.driver.current_url.endswith("index.html")))

    def test_excluded_site_is_left_alone(self):
        self.save_options({"excluded": ["127.0.0.1/*"], "hintChars": CHARS, "newTabActive": False})
        self.open("index.html")
        self.press("j")
        time.sleep(0.4)
        self.assertEqual(self.scroll_y(), 0, "j must not scroll on an excluded site")
        self.assertIn("j", self.js("return window.__keys"))

    def test_custom_hint_characters(self):
        self.save_options({"excluded": [], "hintChars": "xyzw", "newTabActive": False})
        self.open("index.html")
        self.press("f")
        wait(lambda: self.host_attr("mode") == "hints")
        labels = gen_labels(9, "xyzw")
        self.assertTrue(all(set(l) <= set("xyzw") for l in labels))
        for ch in labels[0]:
            self.press(ch)
        self.assertTrue(wait(lambda: self.js("return location.hash") == "#one"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
