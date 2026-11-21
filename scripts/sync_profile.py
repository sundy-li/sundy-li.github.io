#!/usr/bin/env python3
"""Render the profile slots in both homepages from the public profile data."""

import argparse
import json
import re
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

SITE = Path(__file__).resolve().parents[1] / "site"
PAGES = {"en": "index.html", "zh-CN": "zh/index.html"}


def join_list(terms, lang):
    if len(terms) < 2:
        return "".join(terms)
    if lang == "zh-CN":
        return "、".join(terms[:-1]) + " 和 " + terms[-1]
    return ", ".join(terms[:-1]) + (", and " if len(terms) > 2 else " and ") + terms[-1]


def link(url, label, external=False):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"Expected an HTTPS profile URL: {url!r}")
    arrow = ' <span class="arrow" aria-hidden="true">↗</span>' if external else ""
    return f'<a href="{escape(url)}">{escape(label)}{arrow}</a>'


def profile_slots(profile, lang):
    zh = lang == "zh-CN"
    name = escape(profile["name"])
    handle = escape(profile["handle"])
    location = escape(profile["location"][lang])
    university = escape(profile["university"][lang])
    terms = profile["focus_areas"][lang]
    plain_focus = join_list([escape(term) for term in terms], lang)
    focus = join_list([
        f'<span lang="en">{escape(term)}</span>' if zh and term.isascii() else escape(term)
        for term in terms
    ], lang)
    tech_stack = join_list([escape(language) for language in profile["tech_stack"]], lang)
    project = escape(profile["current_project"])
    organization = link(profile["organization_url"], profile["organization"])
    project_link = link(profile["project_url"], profile["current_project"])
    summary = escape(profile["project_summary"][lang])
    early_project = link(profile["early_project_url"], profile["early_project"])
    description = (
        f"{name}（{handle}）的个人主页。专注于{plain_focus}，常驻{location}。" if zh else
        f"{name} ({handle}), focused on {plain_focus} and based in {location}."
    )
    return {
        "description": f'<meta name="description" content="{description}">',
        "title": f'<title>{"关于我" if zh else "Profile"} · {name}</title>',
        "handle": handle,
        "name": name,
        "intro": (
            f"我专注于{focus}，熟悉 {tech_stack}。"
            f"我常驻{location}，毕业于{university}。" if zh else
            f"I focus on {focus}. I work with {tech_stack}. "
            f"I’m based in {location} and graduated from {university}."
        ),
        "github": link(profile["github"], "GitHub", external=True),
        "telegram": link(profile["telegram"], "Telegram", external=True),
        "x": link(profile["x"], "X", external=True),
        "avatar-handle": f"@{handle}",
        "project": project,
        "work": (
            f"我在 {organization} 参与开发 {project_link}，{summary}。早期也曾为 {early_project} 贡献代码。" if zh else
            f"I work at {organization} on {project_link}, {summary}. "
            f"I also contributed to {early_project} earlier in my career."
        ),
        "footer-name": name,
        "source": link(profile["site_source"], "网站源码" if zh else "Site source", external=True),
    }


def render(page, slots, filename):
    for key, content in slots.items():
        start, end = f"<!-- profile:{key} -->", f"<!-- /profile:{key} -->"
        pattern = f"{re.escape(start)}.*?{re.escape(end)}"
        page, count = re.subn(pattern, lambda _: start + content + end, page, flags=re.DOTALL)
        if count != 1:
            raise ValueError(f"{filename}: expected one profile slot for {key!r}, found {count}")
    return page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated profile text is stale")
    args = parser.parse_args()
    profile = json.loads((SITE / "data/profile.json").read_text(encoding="utf-8"))
    stale = []
    for lang, filename in PAGES.items():
        path = SITE / filename
        current = path.read_text(encoding="utf-8")
        expected = render(current, profile_slots(profile, lang), filename)
        if expected != current:
            stale.append(filename)
            if not args.check:
                path.write_text(expected, encoding="utf-8")
    if args.check and stale:
        parser.exit(1, f"Stale profile in {', '.join(stale)}; run python3 scripts/sync_profile.py.\n")


if __name__ == "__main__":
    main()
