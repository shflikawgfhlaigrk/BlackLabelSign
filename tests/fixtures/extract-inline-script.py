"""Extract complete classic inline scripts for the landing VM test, not sanitize HTML."""
import json
import sys
from html.parser import HTMLParser


class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = None
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            attributes = dict(attrs)
            script_type = (attributes.get("type") or "").strip().lower()
            self.active = {
                "classic_inline": "src" not in attributes
                and script_type in ("", "text/javascript", "application/javascript"),
                "chunks": [],
            }

    def handle_data(self, data):
        if self.active is not None:
            self.active["chunks"].append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.active is not None:
            if self.active["classic_inline"]:
                self.sources.append("".join(self.active["chunks"]))
            self.active = None


parser = InlineScripts()
parser.feed(sys.stdin.read())
parser.close()
json.dump(parser.sources, sys.stdout)
