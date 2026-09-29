-- The agent's scripting sandbox: Python run in strict isolation on the serverless SQL warehouse, as the caller.
-- No file system or internal services, nothing shared with other callers; inputs arrive as a zip, and whatever the
-- script writes to OUTPUTS comes back as files. The Studio stores them in the workspace volume as the user.
CREATE OR REPLACE FUNCTION {S}.modflow_sandbox(code STRING, inputs_b64 STRING)
RETURNS STRING
LANGUAGE PYTHON
STRICT ISOLATION
COMMENT 'MODFLOW OS agent sandbox: runs a Python script (numpy, pandas, scipy, matplotlib, flopy, fpdf2, Pillow) over given inputs and returns its printed output and the files it wrote'
ENVIRONMENT (dependencies = '["flopy==3.11.0", "matplotlib", "fpdf2", "scipy", "pillow"]', environment_version = '6')
AS $$
import base64, contextlib, io, json, os, tempfile, traceback, zipfile

class Report:
    """A clean A4 report with fpdf2, Unicode throughout: sections, paragraphs (**bold**), bullets, figures with captions,
    tables and notes, page numbers in the footer. Report(title, subtitle).section(...).text(...).figure(path, caption)
    .table(header, rows).save(path)."""

    def __init__(self, title, subtitle="", author=""):
        from fpdf import FPDF
        import matplotlib
        fonts = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
        rep = self

        class _PDF(FPDF):
            def footer(self):
                self.set_y(-12); self.set_font("DejaVu", size=8); self.set_text_color(120)
                self.cell(0, 6, f"{rep.title}  ·  page {self.page_no()}", align="C")
        self.title, self.pdf, self.fig_n, self.tab_n = title, _PDF(format="A4"), 0, 0
        pdf = self.pdf
        pdf.add_font("DejaVu", fname=os.path.join(fonts, "DejaVuSans.ttf"))
        pdf.add_font("DejaVu", style="B", fname=os.path.join(fonts, "DejaVuSans-Bold.ttf"))
        pdf.add_font("DejaVu", style="I", fname=os.path.join(fonts, "DejaVuSans-Oblique.ttf"))
        pdf.add_font("DejaVu", style="BI", fname=os.path.join(fonts, "DejaVuSans-BoldOblique.ttf"))
        pdf.set_margins(18, 18, 18); pdf.set_auto_page_break(True, 18); pdf.add_page()
        pdf.set_font("DejaVu", "B", 20); pdf.multi_cell(0, 9, title, new_x="LMARGIN", new_y="NEXT")
        if subtitle:
            pdf.set_font("DejaVu", size=11); pdf.set_text_color(90); pdf.multi_cell(0, 6, subtitle, new_x="LMARGIN", new_y="NEXT"); pdf.set_text_color(0)
        if author:
            pdf.set_font("DejaVu", size=9); pdf.set_text_color(120); pdf.multi_cell(0, 5, author, new_x="LMARGIN", new_y="NEXT"); pdf.set_text_color(0)
        pdf.ln(4)

    def section(self, text):
        self.pdf.ln(3); self.pdf.set_font("DejaVu", "B", 13); self.pdf.multi_cell(0, 7, text, new_x="LMARGIN", new_y="NEXT"); self.pdf.ln(1); return self

    def text(self, text):
        self.pdf.set_font("DejaVu", size=10.5); self.pdf.multi_cell(0, 5.4, text, markdown=True, new_x="LMARGIN", new_y="NEXT"); self.pdf.ln(2); return self

    def bullets(self, items):
        self.pdf.set_font("DejaVu", size=10.5)
        for it in items:
            self.pdf.set_x(self.pdf.l_margin + 3); self.pdf.multi_cell(0, 5.4, "•  " + str(it), markdown=True, new_x="LMARGIN", new_y="NEXT")
        self.pdf.ln(2); return self

    def figure(self, path, caption="", width=None):
        from PIL import Image
        w = width or (self.pdf.w - self.pdf.l_margin - self.pdf.r_margin)
        with Image.open(path) as im:
            h = w * im.height / im.width
        if self.pdf.get_y() + h + 12 > self.pdf.h - self.pdf.b_margin:
            self.pdf.add_page()
        self.pdf.image(path, x=(self.pdf.w - w) / 2, w=w); self.fig_n += 1
        if caption:
            self.pdf.set_font("DejaVu", "I", 9); self.pdf.set_text_color(70)
            self.pdf.multi_cell(0, 4.6, f"Figure {self.fig_n}. {caption}", markdown=True, new_x="LMARGIN", new_y="NEXT"); self.pdf.set_text_color(0)
        self.pdf.ln(3); return self

    def table(self, header, rows, caption=""):
        self.tab_n += 1
        if caption:
            self.pdf.set_font("DejaVu", "B", 9.5); self.pdf.multi_cell(0, 5, f"Table {self.tab_n}. {caption}", new_x="LMARGIN", new_y="NEXT")
        self.pdf.set_font("DejaVu", size=9)
        with self.pdf.table(first_row_as_headings=True, line_height=5.2, borders_layout="HORIZONTAL_LINES") as t:
            for r in [header] + [list(r) for r in rows]:
                row = t.row()
                for v in r:
                    row.cell(v if isinstance(v, str) else f"{v:,.2f}" if isinstance(v, float) else str(v))
        self.pdf.ln(3); return self

    def note(self, text):
        self.pdf.set_font("DejaVu", "I", 9); self.pdf.set_text_color(90); self.pdf.multi_cell(0, 4.8, text, markdown=True, new_x="LMARGIN", new_y="NEXT")
        self.pdf.set_text_color(0); self.pdf.ln(2); return self

    def page_break(self):
        self.pdf.add_page(); return self

    def save(self, path):
        self.pdf.output(path); return path


def _main(code, inputs_b64):
    root = tempfile.mkdtemp()
    inp, out = os.path.join(root, "inputs"), os.path.join(root, "outputs")
    os.makedirs(inp); os.makedirs(out)
    if inputs_b64:
        zipfile.ZipFile(io.BytesIO(base64.b64decode(inputs_b64))).extractall(inp)
    for plural, single in (("runs", "run"), ("packages", "package"), ("uploads", "upload"), ("tables", "table")):
        if os.path.isdir(os.path.join(inp, plural)):  # either spelling finds the files
            os.symlink(plural, os.path.join(inp, single))
    # scripts sometimes write to OUTPUTS/... relative, or to an absolute path of their own ending in /OUTPUTS/...:
    # both land in the real folders
    os.symlink(out, os.path.join(root, "OUTPUTS")); os.symlink(inp, os.path.join(root, "INPUTS"))
    import re as _re
    code = _re.sub(r"""(['"])(?:/[^'"\s]*)?/(OUTPUTS|INPUTS)(?=[/'"])""", lambda m: m.group(1) + (out if m.group(2) == "OUTPUTS" else inp), code)
    os.chdir(root)
    import matplotlib
    matplotlib.use("Agg")
    buf, err = io.StringIO(), None
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            fonts = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
            exec(compile(code, "script.py", "exec"), {"__name__": "__main__", "INPUTS": inp, "OUTPUTS": out, "Report": Report,
                                                       "FONT": os.path.join(fonts, "DejaVuSans.ttf"),
                                                       "FONT_BOLD": os.path.join(fonts, "DejaVuSans-Bold.ttf")})
        except SystemExit:
            pass
        except BaseException:
            err = traceback.format_exc()[-5000:]
    files, total = [], 0
    for dp, _, fs in os.walk(out):
        for f in sorted(fs):
            p = os.path.join(dp, f)
            b = open(p, "rb").read()
            total += len(b)
            if total > 20_000_000:
                err = (err or "") + "\nOutputs beyond 20 MB were dropped."
                break
            files.append({"name": os.path.relpath(p, out), "b64": base64.b64encode(b).decode()})
    return json.dumps({"stdout": buf.getvalue()[-20000:], "error": err, "files": files})

return _main(code or "", inputs_b64 or "")
$$;
GRANT EXECUTE ON FUNCTION {S}.modflow_sandbox TO `account users`;
