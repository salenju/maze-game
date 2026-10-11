#!/usr/bin/env python3
"""
生成 PWA 所需的图标。

为什么用脚本生成而不是手动放图：图标必须成套（192 / 512 / maskable / apple-touch），
尺寸写错会导致安装后图标模糊或被裁切，而这属于「装完才发现」的问题，
在平板上一旦发生很难排查。脚本化后每次调整都是确定性的。

maskable 版本额外留出 20% 安全边距：安卓会把图标裁成圆形/圆角方形，
贴边的图形会被切掉。
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (15, 23, 41, 255)
WALL = (232, 238, 252, 255)
ACCENT = (255, 207, 77, 255)
GLOW = (122, 162, 255, 255)


def draw_maze_icon(size: int, safe_ratio: float) -> Image.Image:
    """画一个简化的迷宫：外框 + 内部墙体 + 中央小黄球。"""
    # 4x 超采样再缩小，得到平滑边缘（PIL 没有内建抗锯齿绘图）
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)

    margin = s * 0.14
    inner = s - margin * 2
    line = max(2, int(inner * 0.11))

    # 外框
    d.rounded_rectangle(
        [margin, margin, s - margin, s - margin],
        radius=inner * 0.12,
        outline=WALL,
        width=line,
    )

    # 内部墙体：错落的两段，构成「迷宫」的直观印象
    c1 = margin + inner * 0.34
    d.line([(c1, margin), (c1, margin + inner * 0.32)], fill=WALL, width=line)
    c2 = margin + inner * 0.66
    d.line([(c2, s - margin), (c2, s - margin - inner * 0.32)], fill=WALL, width=line)
    mid = margin + inner * 0.5
    d.line([(margin, mid), (margin + inner * 0.3, mid)], fill=WALL, width=line)
    d.line([(s - margin, mid), (s - margin - inner * 0.3, mid)], fill=WALL, width=line)

    # 中央小黄球。
    # 注意：ImageDraw 在 RGBA 图上填半透明色是「替换像素」而非「混合」，
    # 直接画会得到一块不透明的浅色圆盘。必须画到独立图层再用 alpha_composite 叠加。
    cx = cy = s / 2
    r = inner * 0.13
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [cx - r * 1.75, cy - r * 1.75, cx + r * 1.75, cy + r * 1.75],
        fill=(*GLOW[:3], 60),
    )
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # 小球本体的实心圆 + 一圈同色描边，让小尺寸下也清晰
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    d.ellipse(
        [cx - r * 1.32, cy - r * 1.32, cx + r * 1.32, cy + r * 1.32],
        outline=(*ACCENT[:3], 120),
        width=max(2, int(r * 0.3)),
    )

    # maskable 需要把内容收进安全区，用背景色加边实现
    if safe_ratio > 0:
        pad = int(s * safe_ratio)
        canvas = Image.new("RGBA", (s, s), BG)
        shrunk = img.resize((s - pad * 2, s - pad * 2), Image.LANCZOS)
        canvas.paste(shrunk, (pad, pad), shrunk)
        img = canvas

    return img.resize((size, size), Image.LANCZOS)


def write(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    print(f"  {path.name}  {path.stat().st_size / 1024:.1f} KB")


def main() -> None:
    print(f"生成图标到 {OUT}")
    # 普通图标：内容可以贴得比较满
    write(draw_maze_icon(192, 0.0), OUT / "icon-192.png")
    write(draw_maze_icon(512, 0.0), OUT / "icon-512.png")
    # maskable：留 20% 安全边距（安卓裁切用）
    write(draw_maze_icon(512, 0.10), OUT / "icon-maskable-512.png")
    # iOS 主屏幕图标：必须是 180x180，否则会被系统缩放导致发虚
    write(draw_maze_icon(180, 0.0), OUT / "apple-touch-icon.png")

    # SVG 版本给浏览器标签页用，任意尺寸都清晰
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0f1729"/>
  <rect x="9" y="9" width="46" height="46" rx="7" fill="none" stroke="#e8eefc" stroke-width="5"/>
  <path d="M24 9v15M40 55V40M9 32h14M55 32H41" stroke="#e8eefc" stroke-width="5" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="7" fill="#ffcf4d"/>
</svg>
"""
    favicon = OUT / "favicon.svg"
    favicon.write_text(svg, encoding="utf-8")
    print(f"  {favicon.name}  {favicon.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
