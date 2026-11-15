"""JMA seismic intensity helpers (codes, labels, colours, math)."""
from __future__ import annotations

SCALE_CODES = {
    -1: None,
    0: 0.0,
    10: 1.0,
    20: 2.0,
    30: 3.0,
    40: 4.0,
    45: 5.0,   # 5弱
    46: 5.0,   # some feeds use 46/50 pairs
    50: 5.5,   # 5強
    55: 6.0,   # 6弱
    60: 6.5,   # 6強
    70: 7.0,
}
LABELS = {
    0.0: "0", 1.0: "1", 2.0: "2", 3.0: "3", 4.0: "4",
    5.0: "5弱", 5.5: "5強", 6.0: "6弱", 6.5: "6強", 7.0: "7",
}
# official JMA colours, used by the "jma" palette
JMA_COLORS = {
    0.0: "#FFFFFF", 1.0: "#F2F2FF", 2.0: "#00AAFF", 3.0: "#0041FF",
    4.0: "#FAE696", 5.0: "#FFE600", 5.5: "#FF9900", 6.0: "#FF2800",
    6.5: "#A50021", 7.0: "#B40068",
}


def code_to_value(code):
    if code is None:
        return None
    try:
        code = int(code)
    except (TypeError, ValueError):
        return None
    if code in SCALE_CODES:
        return SCALE_CODES[code]
    # tolerate values already expressed in 0.5 steps (e.g. 5.0)
    if 0 <= code <= 7:
        return float(code)
    return None


def xml_int_to_value(text):
    """Parse JMA XML <Int> text: '3', '5-', '5+', '６弱' ..."""
    if text is None:
        return None
    t = str(text).strip()
    if not t:
        return None
    table = {"5-": 5.0, "5+": 5.5, "6-": 6.0, "6+": 6.5}
    if t in table:
        return table[t]
    t = t.replace("弱", "").replace("強", "")
    t = t.translate(str.maketrans("０１２３４５６７", "01234567"))
    try:
        return float(t)
    except ValueError:
        return None


def label(value):
    if value is None:
        return "—"
    try:
        value = float(value)
    except (TypeError, ValueError):
        return "—"
    for bound, text in LABELS.items():
        if abs(value - bound) < 0.01:
            return text
    # continuous values -> nearest class label with a decimal
    if value >= 7:
        return "7"
    if value <= 0:
        return "0"
    return f"{value:.1f}"


def step_label(value):
    """Coarse class for grouping (5.0/5.5/6.0/6.5 preserved)."""
    if value is None:
        return "—"
    v = float(value)
    if v < 0.5:
        return "0"
    if v < 1.5:
        return "1"
    if v < 2.5:
        return "2"
    if v < 3.5:
        return "3"
    if v < 4.5:
        return "4"
    if v < 5.25:
        return "5弱"
    if v < 5.75:
        return "5強"
    if v < 6.25:
        return "6弱"
    if v < 6.75:
        return "6強"
    return "7"


def color(value, palette="shinreki"):
    if palette == "jma":
        key = None
        if value is not None:
            key = min(LABELS, key=lambda k: abs(k - float(value))) if float(value) >= 0.5 else 0.0
        return JMA_COLORS.get(key or 0.0, "#FFFFFF")
    # shinreki: continuous ramp
    anchors = [
        (0.0, (26, 42, 74)),
        (0.4, (32, 62, 120)),
        (1.0, (45, 107, 255)),
        (2.0, (34, 199, 201)),
        (3.0, (140, 226, 79)),
        (4.0, (255, 212, 71)),
        (5.0, (255, 138, 43)),
        (5.5, (255, 90, 60)),
        (6.0, (232, 38, 60)),
        (6.5, (192, 18, 79)),
        (7.0, (142, 31, 181)),
    ]
    v = 0.0 if value is None else max(0.0, min(7.0, float(value)))
    for i in range(1, len(anchors)):
        if v <= anchors[i][0]:
            a, ca = anchors[i - 1]
            b, cb = anchors[i]
            t = 0.0 if b == a else (v - a) / (b - a)
            rgb = tuple(int(round(ca[j] + (cb[j] - ca[j]) * t)) for j in range(3))
            return "#%02X%02X%02X" % rgb
    return "#8E1FB5"


def attenuation(pga_like):
    """Very rough counter for 'what would this be at my place' hints."""
    return pga_like
