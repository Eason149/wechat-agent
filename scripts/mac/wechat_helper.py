#!/usr/bin/env python3
"""
macOS 微信本地自动化助手（pyobjc）

只做四件事，全部通过系统公开接口：
  probe  体检：辅助功能/屏幕录制权限、微信窗口位置、能读到多少字
  bounds 微信主窗口的屏幕坐标
  read   读当前聊天：优先 OCR 截图，退化到 AX 无障碍树
  send   往当前聊天发一条消息（剪贴板 + Cmd+V + 回车）

不做协议逆向、不读数据库、不注入进程。所有输出都是 JSON。

用法：
  .tools/venv/bin/python scripts/mac/wechat_helper.py probe
  .tools/venv/bin/python scripts/mac/wechat_helper.py read --mode ocr
  .tools/venv/bin/python scripts/mac/wechat_helper.py send --text "你好"
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

try:
    import Quartz
    import AppKit
    from ApplicationServices import (
        AXIsProcessTrusted,
        AXUIElementSetAttributeValue,
        AXUIElementCreateApplication,
        AXUIElementCopyAttributeValue,
        kAXChildrenAttribute,
        kAXWindowsAttribute,
        kAXMinimizedAttribute,
        kAXFocusedUIElementAttribute,
        kAXRoleAttribute,
        kAXTitleAttribute,
        kAXValueAttribute,
        kAXDescriptionAttribute,
    )
    from Vision import VNRecognizeTextRequest, VNImageRequestHandler
except Exception as exc:  # pragma: no cover - 环境没装 pyobjc 时给出可读错误
    print(json.dumps({"ok": False, "error": f"缺少 pyobjc：{exc}"}, ensure_ascii=False))
    sys.exit(2)

WECHAT_BUNDLE = "com.tencent.xinWeChat"

# 截图只写到私有临时目录，用完立刻删；不留原始帧
TMP_DIR = os.path.join(tempfile.gettempdir(), "wechat-agent")
KEEP_FRAMES = os.environ.get("WX_KEEP_FRAMES", "0") == "1"


def ensure_tmp():
    os.makedirs(TMP_DIR, mode=0o700, exist_ok=True)
    return TMP_DIR


def frame_path(name="chat"):
    ensure_tmp()
    return os.path.join(TMP_DIR, f"{name}-{os.getpid()}.png")


def drop(path):
    if KEEP_FRAMES:
        return
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def sweep_tmp(max_age_sec=3600):
    """启动时清掉上次崩溃可能留下的残帧"""
    try:
        now = time.time()
        for name in os.listdir(ensure_tmp()):
            full = os.path.join(TMP_DIR, name)
            if os.path.isfile(full) and now - os.path.getmtime(full) > max_age_sec:
                os.remove(full)
    except OSError:
        pass


# ---------------------------------------------------------------- 基础能力


def wechat_apps():
    return [
        a
        for a in AppKit.NSRunningApplication.runningApplicationsWithBundleIdentifier_(
            WECHAT_BUNDLE
        )
    ]


def frontmost_bundle():
    try:
        return str(AppKit.NSWorkspace.sharedWorkspace().frontmostApplication().bundleIdentifier() or "")
    except Exception:
        return ""


def wechat_frontmost():
    return frontmost_bundle() == WECHAT_BUNDLE


def wechat_pid():
    apps = wechat_apps()
    return apps[0].processIdentifier() if apps else None


def accessibility_trusted():
    return bool(AXIsProcessTrusted())


def window_info():
    """返回微信主窗口的屏幕坐标与窗口号（用于 -l 截图）。"""
    pid = wechat_pid()
    if not pid:
        return None
    # 用 OptionAll：别的桌面/被遮挡的窗口也能找到；全屏的那种也排除掉
    opts = Quartz.kCGWindowListOptionAll
    infos = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    best = None
    for info in infos:
        if info.get("kCGWindowOwnerPID") != pid:
            continue
        b = info.get("kCGWindowBounds") or {}
        w, h = float(b.get("Width", 0)), float(b.get("Height", 0))
        if w < 120 or h < 100 or int(info.get("kCGWindowLayer", 0)) != 0:
            continue
        if best is None or w * h > best["width"] * best["height"]:
            best = {
                "number": int(info.get("kCGWindowNumber", 0)),
                "x": float(b.get("X", 0)),
                "y": float(b.get("Y", 0)),
                "width": w,
                "height": h,
                "layer": int(info.get("kCGWindowLayer", 0)),
                "name": str(info.get("kCGWindowName") or ""),
            }
    return best


def capture_window(win, allow_raise=True):
    """返回 (图片路径, 像素宽, 像素高, 模式)。微信把窗口设成不可单独截取，退回整屏裁剪。"""
    tmp = frame_path("chat")
    drop(tmp)

    # 1) 最可靠：直接向窗口要像素。窗口被别的应用盖住也能拿到，且不抢焦点
    img = Quartz.CGWindowListCreateImage(
        Quartz.CGRectNull,
        Quartz.kCGWindowListOptionIncludingWindow,
        win["number"],
        Quartz.kCGWindowImageBoundsIgnoreFraming,
    )
    if img is not None and Quartz.CGImageGetWidth(img) > 100:
        save_image(img, tmp)
        return tmp, Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img), "cgwindow"

    # 2) 退回命令行截图
    r = subprocess.run(
        ["screencapture", "-x", "-o", "-l", str(win["number"]), tmp], capture_output=True, text=True
    )
    if r.returncode == 0 and os.path.exists(tmp):
        img = load_image(tmp)
        if img:
            return tmp, Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img), "window"

    # 窗口最小化时拿不到像素：只有允许抢焦点才把它拉回来
    if not allow_raise:
        return None, 0, 0, "invisible"
    activate_wechat()
    time.sleep(0.45)

    full = frame_path("full")
    subprocess.run(["screencapture", "-x", "-o", full], capture_output=True, text=True)
    img = load_image(full)
    if img is None:
        return None, 0, 0, "failed"

    main = Quartz.CGMainDisplayID()
    scale = Quartz.CGDisplayPixelsWide(main) / Quartz.CGDisplayBounds(main).size.width
    rect = Quartz.CGRectMake(win["x"] * scale, win["y"] * scale, win["width"] * scale, win["height"] * scale)
    crop = Quartz.CGImageCreateWithImageInRect(img, rect)
    if crop is None:
        return None, 0, 0, "failed"
    save_image(crop, tmp)
    return tmp, Quartz.CGImageGetWidth(crop), Quartz.CGImageGetHeight(crop), "fullscreen-crop"


def capture_ocr(win, allow_raise=True, region=None):
    """截图→OCR，返回 (boxes, 宽, 高, 模式)。region=(x0,y0,x1,y1) 是 0–1 的相对区域，用于只看输入框"""
    path, iw, ih, mode = capture_window(win, allow_raise=allow_raise)
    if not path:
        return [], 0, 0, mode
    try:
        if not region:
            return ocr_image(path), iw, ih, mode
        img = load_image(path)
        if img is None:
            return [], iw, ih, mode
        x0, y0, x1, y1 = region
        rect = Quartz.CGRectMake(iw * x0, ih * y0, iw * (x1 - x0), ih * (y1 - y0))
        crop = Quartz.CGImageCreateWithImageInRect(img, rect)
        if crop is None:
            return [], iw, ih, mode
        tmp = frame_path("crop")
        save_image(crop, tmp)
        try:
            boxes = ocr_image(tmp)
        finally:
            drop(tmp)
        return boxes, Quartz.CGImageGetWidth(crop), Quartz.CGImageGetHeight(crop), mode
    finally:
        drop(path)


def load_image(path):
    url = Quartz.CFURLCreateFromFileSystemRepresentation(None, path.encode(), len(path.encode()), False)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    return Quartz.CGImageSourceCreateImageAtIndex(src, 0, None) if src else None


def save_image(img, path):
    url = Quartz.CFURLCreateFromFileSystemRepresentation(None, path.encode(), len(path.encode()), False)
    dest = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    if dest:
        Quartz.CGImageDestinationAddImage(dest, img, None)
        Quartz.CGImageDestinationFinalize(dest)


def screenshot(path, window_number):
    cmd = ["screencapture", "-x", "-o"]
    if window_number:
        cmd += ["-l", str(window_number)]
    cmd.append(path)
    r = subprocess.run(cmd, capture_output=True, text=True)
    return {"ok": r.returncode == 0 and os.path.exists(path), "stderr": r.stderr.strip()}


def screen_recording_works():
    """截一张图，检查是不是全黑（没有屏幕录制权限时拿到的是黑图/空图）。"""
    tmp = "/tmp/_wx_probe.png"
    if os.path.exists(tmp):
        os.remove(tmp)
    res = screenshot(tmp, None)
    if not res["ok"]:
        return False, res.get("stderr", "")
    try:
        url = Quartz.CFURLCreateFromFileSystemRepresentation(None, tmp.encode(), len(tmp.encode()), False)
        img = Quartz.CGImageSourceCreateImageAtIndex(
            Quartz.CGImageSourceCreateWithURL(url, None), 0, None
        )
        if img is None:
            return False, "读不出截图"
        w = Quartz.CGImageGetWidth(img)
        h = Quartz.CGImageGetHeight(img)
        return (w > 0 and h > 0), f"{w}x{h}"
    except Exception as exc:
        return False, str(exc)


# ---------------------------------------------------------------- 读消息


def ocr_image(path, languages=("zh-Hans", "en-US"), level=0):
    """返回 [{text, x, y, w, h, conf}]，坐标是像素，左上角原点。"""
    url = Quartz.CFURLCreateFromFileSystemRepresentation(None, path.encode(), len(path.encode()), False)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None:
        return []
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if img is None:
        return []

    results = []

    def handler(request, error):
        if error:
            return
        for obs in request.results() or []:
            cand = obs.topCandidates_(1)
            if not cand:
                continue
            text = cand[0].string()
            box = obs.boundingBox()  # 归一化，左下角原点
            W = Quartz.CGImageGetWidth(img)
            H = Quartz.CGImageGetHeight(img)
            x = box.origin.x * W
            w = box.size.width * W
            h = box.size.height * H
            y = (1 - box.origin.y - box.size.height) * H
            results.append(
                {
                    "text": text,
                    "x": round(x, 1),
                    "y": round(y, 1),
                    "w": round(w, 1),
                    "h": round(h, 1),
                    "conf": round(float(cand[0].confidence()), 3),
                }
            )

    req = VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    # 0 = fast。别改成 1：macOS 的 accurate 级别只支持拉丁语系，中文会认成乱码（实测）
    req.setRecognitionLevel_(level)
    req.setRecognitionLanguages_(list(languages))
    req.setUsesLanguageCorrection_(True)
    VNImageRequestHandler.alloc().initWithCGImage_options_(img, {}).performRequests_error_(
        [req], None
    )
    return results


NOISE_TEXTS = ("按住鼠标", "语音输入文字", "发送", "搜索")


def _is_noise(b):
    t = b["text"].strip()
    if not t:
        return True
    if any(w in t for w in NOISE_TEXTS):
        return True
    if re.fullmatch(r"\d{1,2}:\d{2}", t):  # 聊天气泡之间的时间戳
        return True
    if re.fullmatch(r"[\s·•。.…]+", t):
        return True
    return False


def cluster_messages(boxes, bounds):
    """
    把 OCR 结果还原成聊天气泡。
    经验规则（都用窗口相对比例，分辨率无关）：
      - 聊天区：横向 28% 右侧，纵向 6%–88%（88% 以下是输入框）
      - 昵称：紧贴左侧气泡上方、比气泡更靠左、字更小的一行
      - 自己在右：中心点超过 62% 宽度
    """
    if not bounds:
        return []
    W, H = bounds["width"], bounds["height"]
    raw = [b for b in boxes if b["x"] > W * 0.28 and H * 0.06 < b["y"] < H * 0.88 and b["conf"] > 0.3]
    raw = [b for b in raw if not _is_noise(b)]
    raw.sort(key=lambda b: (b["y"], b["x"]))

    # 1. 同一行的碎片按 y 聚成 row
    rows = []
    for b in raw:
        cy = b["y"] + b["h"] / 2
        for row in rows:
            if abs(row["cy"] - cy) <= max(b["h"], row["h"]) * 0.6:
                row["items"].append(b)
                row["cy"] = (row["cy"] + cy) / 2
                row["h"] = max(row["h"], b["h"])
                break
        else:
            rows.append({"cy": cy, "h": b["h"], "items": [b]})
    rows.sort(key=lambda r: r["cy"])

    for row in rows:
        row["items"].sort(key=lambda b: b["x"])
        row["text"] = "".join(i["text"] for i in row["items"]).strip()
        row["x0"] = row["items"][0]["x"]
        x1 = row["items"][-1]["x"] + row["items"][-1]["w"]
        row["side"] = "self" if (row["x0"] + x1) / 2 > W * 0.62 else "other"

    # 2. 认昵称：比下面那个左侧气泡更靠左、更矮、很短
    for i, row in enumerate(rows):
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if not nxt or nxt["side"] != "other":
            continue
        gap = nxt["cy"] - row["cy"]
        if (
            row["x0"] < nxt["x0"] - 8
            and row["h"] <= nxt["h"]
            and len(row["text"]) <= 20
            and 0 < gap <= max(row["h"], nxt["h"]) * 2.2
        ):
            row["is_name"] = True
            nxt["sender"] = row["text"]

    # 3. 连续同侧、同昵称、行距小的 row 合并成一个气泡
    bubbles = []
    for row in rows:
        if row.get("is_name"):
            continue
        sender = row.get("sender") or ("我" if row["side"] == "self" else "群友")
        prev = bubbles[-1] if bubbles else None
        if (
            prev
            and prev["side"] == row["side"]
            and prev["sender"] == sender
            and row["cy"] - prev["cy"] <= max(row["h"], prev["h"]) * 1.6
        ):
            prev["text"] += row["text"]
            prev["cy"] = row["cy"]
            prev["h"] = max(prev["h"], row["h"])
            continue
        bubbles.append({"side": row["side"], "sender": sender, "text": row["text"], "cy": row["cy"], "h": row["h"]})

    return [{"sender": b["sender"], "text": b["text"]} for b in bubbles if b["text"].strip()]


AX_ATTRS = [
    (kAXRoleAttribute, "role"),
    (kAXTitleAttribute, "title"),
    (kAXValueAttribute, "value"),
    (kAXDescriptionAttribute, "desc"),
]


def ax_walk(element, depth=0, out=None, max_nodes=400):
    """深度优先遍历 AX 树，收集有文字的节点。"""
    if out is None:
        out = []
    if depth > 12 or len(out) >= max_nodes:
        return out
    vals = {}
    for attr, name in AX_ATTRS:
        try:
            err, v = AXUIElementCopyAttributeValue(element, attr, None)
            if err == 0 and v is not None:
                vals[name] = str(v)
        except Exception:
            pass
    text = " ".join(vals.get(k, "") for k in ("title", "value", "desc")).strip()
    if text and vals.get("role") not in ("AXWindow", "AXGroup", "AXScrollArea"):
        out.append({"role": vals.get("role", ""), "text": text[:200]})
    try:
        err, children = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, None)
        if err == 0 and children:
            for child in children:
                ax_walk(child, depth + 1, out, max_nodes)
    except Exception:
        pass
    return out


def args_allow_raise():
    return os.environ.get("WX_ALLOW_RAISE", "0") == "1"


def read_messages(mode="auto"):
    win = window_info()
    if not win:
        return {"ok": False, "error": "找不到微信窗口（没运行？）"}
    if not accessibility_trusted():
        return {"ok": False, "error": "没有『辅助功能』权限", "need": "accessibility"}

    result = {"ok": True, "mode": mode, "bounds": win, "messages": [], "debug": {}}

    if mode in ("auto", "ocr"):
        boxes, iw, ih, capmode = capture_ocr(win, allow_raise=args_allow_raise())
        result["debug"]["capture"] = capmode
        if not iw:
            result["ok"] = False
            result["error"] = {
                "invisible": "微信窗口被最小化或关掉了，拿不到画面（还原窗口，或打开 autoRaise）",
                "not-frontmost": "微信不在前台，截不到内容（把微信切到前台，或打开 autoRaise）",
                "failed": "截图失败",
            }.get(capmode, "截图失败")
            return result
        result["debug"]["ocr_boxes"] = len(boxes)
        msgs = cluster_messages(boxes, {"width": iw, "height": ih})
        if msgs:
            result["mode"] = "ocr"
            result["messages"] = msgs
            return result
        if mode == "ocr":
            result["ok"] = False
            result["error"] = "OCR 没认出聊天内容（窗口被遮住？没给屏幕录制权限？）"
            return result

    pid = wechat_pid()
    if pid:
        app = AXUIElementCreateApplication(pid)
        nodes = ax_walk(app)
        result["debug"]["ax_nodes"] = len(nodes)
        texts = [n["text"] for n in nodes if n["text"]]
        result["mode"] = "ax"
        result["messages"] = [{"sender": "未知", "text": t} for t in texts[-40:]]
        if not texts:
            result["ok"] = False
            result["error"] = "AX 树里没读到文字"
    return result


# ---------------------------------------------------------------- 发消息


def post_key(keycode, flags=0):
    for down in (True, False):
        evt = Quartz.CGEventCreateKeyboardEvent(None, keycode, down)
        if flags:
            Quartz.CGEventSetFlags(evt, flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
        time.sleep(0.01)


def click_at(x, y):
    move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (x, y), 0)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
    time.sleep(0.05)
    for kind in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
        evt = Quartz.CGEventCreateMouseEvent(None, kind, (x, y), 0)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
        time.sleep(0.02)


def set_clipboard(text):
    pb = AppKit.NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(text, AppKit.NSPasteboardTypeString)


def unminimize():
    """把最小化的窗口还原（需要辅助功能权限）"""
    pid = wechat_pid()
    if not pid:
        return False
    restored = False
    try:
        app = AXUIElementCreateApplication(pid)
        err, wins = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, None)
        if err == 0 and wins:
            for w in wins:
                err2, mini = AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute, None)
                if err2 == 0 and mini:
                    AXUIElementSetAttributeValue(w, kAXMinimizedAttribute, False)
                    restored = True
    except Exception:
        pass
    return restored


def activate_wechat():
    apps = wechat_apps()
    if not apps:
        return False
    unminimize()
    apps[0].activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
    time.sleep(0.45)
    return True


INPUT_LABELS = ("发送", "按住鼠标", "语音输入", "输入消息", "①", "②", "③", "④", "⑨")


def input_has_text(win=None):
    """只看输入框那一条：里面还有没有字。这是"发没发出去"最直接的证据"""
    win = win or window_info()
    if not win:
        return False, ""
    boxes, iw, ih, mode = capture_ocr(win, allow_raise=False, region=(0.28, 0.84, 0.99, 1.0))
    words = []
    for b in boxes:
        t = b["text"].strip()
        if not t or any(l in t for l in INPUT_LABELS):
            continue
        if re.fullmatch(r"[\s\W_]+", t):
            continue
        words.append(t)
    return bool(words), " ".join(words)[:40]


def wait_input_empty(win, timeout=3.5):
    """按下发送键后轮询：输入框变空 = 发出去了"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.35)
        busy, _ = input_has_text(win)
        if not busy:
            return True
    return False


def message_count():
    res = read_messages("ocr")
    return len(res.get("messages") or []) if res.get("ok") else -1


def message_appeared(text, win, before_count=-1):
    """发送成功的判据：聊天记录条数变多，或最后几条里能读到这句话"""
    res = read_messages("ocr")
    if not res.get("ok"):
        return False
    msgs = res.get("messages") or []
    if before_count >= 0 and len(msgs) > before_count:
        return True
    probe = re.sub(r"\s+", "", text)[:8]
    if not probe:
        return False
    return any(probe in re.sub(r"\s+", "", m["text"]) for m in msgs[-6:])


def press_send(shortcut):
    """微信的发送快捷键可以设成回车或 ⌘+回车，两种都试"""
    if shortcut == "cmd+enter":
        post_key(36, Quartz.kCGEventFlagMaskCommand)
    else:
        post_key(36)


def ax_input():
    """直接问系统要输入框里的文字（比 OCR 准得多）"""
    pid = wechat_pid()
    if not pid:
        return None, None
    app = AXUIElementCreateApplication(pid)
    err, el = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, None)
    if err != 0 or not el:
        return None, None
    err2, val = AXUIElementCopyAttributeValue(el, kAXValueAttribute, None)
    if err2 != 0 or val is None:
        return el, None
    return el, str(val)


def ax_set_input(text):
    el, _ = ax_input()
    if el is None:
        return False
    return AXUIElementSetAttributeValue(el, kAXValueAttribute, text) == 0


def clear_input():
    """清空输入框：AX 直接置空，失败再退回 Cmd+A + 删除"""
    if ax_set_input(""):
        time.sleep(0.1)
        _, v = ax_input()
        if not v:
            return True
    post_key(0, Quartz.kCGEventFlagMaskCommand)
    time.sleep(0.08)
    post_key(51)
    time.sleep(0.1)
    return False


def input_is_empty(win=None):
    _, v = ax_input()
    if v is not None:
        return v.strip() == ""
    # AX 读不到时退回 OCR
    busy, _text = input_has_text(win)
    return not busy


def send_text(text, dry_run=False, send_key="enter"):
    win = window_info()
    if not win:
        return {"ok": False, "error": "找不到微信窗口"}
    if not accessibility_trusted():
        return {"ok": False, "error": "没有『辅助功能』权限", "need": "accessibility"}

    if not activate_wechat():
        return {"ok": False, "error": "激活微信失败"}
    if not wechat_frontmost():
        time.sleep(0.4)
        activate_wechat()
    win = window_info() or win

    # 点输入框 → 清空 → 粘贴
    click_at(win["x"] + win["width"] * 0.62, win["y"] + win["height"] - 58)
    time.sleep(0.25)
    clear_input()
    time.sleep(0.15)
    set_clipboard(text)
    time.sleep(0.1)
    post_key(9, Quartz.kCGEventFlagMaskCommand)   # Cmd+V
    time.sleep(0.4)

    if dry_run:
        return {"ok": True, "dry_run": True, "text": text}

    # 回车如果只是换行，就别再试第二次；换成点发送按钮
    order = [send_key] + [k for k in ("click", "cmd+enter", "enter") if k != send_key]
    tried = []
    for shortcut in order:
        if shortcut in tried:
            continue
        tried.append(shortcut)
        if shortcut == "click":
            w = window_info() or win
            click_at(w["x"] + w["width"] * 0.93, w["y"] + w["height"] * 0.945)
        else:
            press_send(shortcut)
        for _ in range(8):
            time.sleep(0.25)
            if input_is_empty(win):
                return {"ok": True, "text": text, "sent": True, "shortcut": shortcut}

    leftover = ax_input()[1] or ""
    return {
        "ok": False,
        "text": text,
        "sent": False,
        "tried": tried,
        "leftover": leftover[:60],
        "error": f"没发出去，输入框里还留着：{leftover[:40] or '(读不到)'}",
    }


def copy_all_transcript():
    """在当前聊天里 Cmd+A / Cmd+C，返回剪贴板文本。会覆盖剪贴板（调用方负责恢复）。"""
    win = window_info()
    if not win:
        return {"ok": False, "error": "找不到微信窗口"}
    if not activate_wechat():
        return {"ok": False, "error": "激活微信失败"}
    # 点消息区，让焦点落在聊天记录上
    click_at(win["x"] + win["width"] * 0.6, win["y"] + win["height"] * 0.45)
    time.sleep(0.2)
    post_key(0, Quartz.kCGEventFlagMaskCommand)  # A
    time.sleep(0.15)
    post_key(8, Quartz.kCGEventFlagMaskCommand)  # C
    time.sleep(0.25)
    r = subprocess.run(["pbpaste"], capture_output=True, text=True)
    return {"ok": True, "text": r.stdout}


# ---------------------------------------------------------------- CLI


def main():
    sweep_tmp()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["probe", "bounds", "read", "send", "copy-all"])
    ap.add_argument("--mode", default="auto", choices=["auto", "ocr", "ax"])
    ap.add_argument("--text", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--send-key", default="enter", choices=["enter", "cmd+enter", "click"])
    args = ap.parse_args()

    if args.cmd == "bounds":
        out = {"ok": True, "bounds": window_info()}
    elif args.cmd == "probe":
        screen_ok, screen_detail = screen_recording_works()
        out = {
            "ok": True,
            "wechat": {"running": bool(wechat_pid()), "pid": wechat_pid()},
            "permissions": {
                "accessibility": accessibility_trusted(),
                "screen_recording": screen_ok,
                "screen_recording_detail": screen_detail,
            },
            "window": window_info(),
        }
        win = out["window"]
        if win and screen_ok:
            boxes, iw, ih, capmode = capture_ocr(win, allow_raise=args_allow_raise())
            out["frontmost"] = wechat_frontmost()
            out["capture"] = capmode
            if iw:
                out["ocr"] = {
                    "boxes": len(boxes),
                    "sample": [b["text"] for b in boxes[:8]],
                    "chat_messages": len(cluster_messages(boxes, {"width": iw, "height": ih})),
                }
    elif args.cmd == "read":
        out = read_messages(args.mode)
    elif args.cmd == "copy-all":
        out = copy_all_transcript()
    else:
        out = send_text(args.text, args.dry_run, args.send_key)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
