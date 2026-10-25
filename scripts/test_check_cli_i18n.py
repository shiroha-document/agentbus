import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("cli_i18n_scan", Path(__file__).with_name("check-cli-i18n.py"))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class ScannerTests(unittest.TestCase):
    def scan(self, source):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "cmd").mkdir()
            (root / "cmd" / "sample.go").write_text(source, encoding="utf-8")
            with patch.object(scanner, "ROOT", root), patch("sys.argv", ["scan", "--strict"]), contextlib.redirect_stdout(io.StringIO()):
                return scanner.main()

    def test_untranslated_output_fails_for_all_print_functions(self):
        for function in ["Print", "Printf", "Println", "Fprint", "Fprintf", "Fprintln"]:
            with self.subTest(function=function):
                writer = "c.out, " if function.startswith("F") else ""
                self.assertEqual(self.scan(f'fmt.{function}({writer}"new untranslated output\\n")'), 2)

    def test_localized_and_structural_output_passes(self):
        for source in ['fmt.Fprintln(c.out, i18n.Pick("new output", "新输出"))', 'fmt.Fprintf(c.out, "%s\\n", name)']:
            with self.subTest(source=source):
                self.assertEqual(self.scan(source), 0)


if __name__ == "__main__":
    unittest.main()
