import re

MARKER_RE = re.compile(r"<!--\s*pr-housekeeping-response:\s*([^\s]+)\s*-->")


def source_key(kind, item):
    return f"{kind}:{item.get('id') or item.get('node_id')}"


def response_markers(issue_comments):
    markers = set()
    for comment in issue_comments:
        for match in MARKER_RE.finditer(comment.get("body") or ""):
            markers.add(match.group(1))
    return markers


def created_at(item):
    return item.get("created_at") or item.get("createdAt") or item.get("submitted_at") or item.get("submittedAt") or ""


def author_login(item):
    return ((item.get("user") or item.get("author") or {}).get("login"))


def pending_sources(feedback):
    issue_comments = feedback.get("issue_comments") or []
    markers = response_markers(issue_comments)
    existing_replies = [c for c in issue_comments if author_login(c) == "wilbrt"]
    pending = []

    for item in feedback.get("review_comments") or []:
        key = source_key("review-comment", item)
        if key in markers:
            continue
        # Bootstrap for comments posted before markers existed: a maintainer PR comment
        # after the review comment is treated as an existing response.
        item_created = created_at(item)
        if any(created_at(reply) > item_created for reply in existing_replies):
            continue
        pending.append({"kind": "review-comment", "key": key, "item": item})

    for item in issue_comments:
        key = source_key("issue-comment", item)
        if key in markers:
            continue
        if author_login(item) == "wilbrt":
            continue
        pending.append({"kind": "issue-comment", "key": key, "item": item})

    return pending
