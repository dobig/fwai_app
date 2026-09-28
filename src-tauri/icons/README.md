# 应用图标

标志是一道拱门:拱门是网关,上半部的闸门是防火墙,橙色圆点是通过检查的请求。
与官网 fwai.space 使用同一个标志。

| 源文件 | 生成 |
|---|---|
| `source.svg` | Windows / Linux / 移动端的全部 PNG 和 `icon.ico`,以及 `src/assets/icons/app-icon.png` |
| `source-macos.svg` | `icon.icns`。按 Apple 的图标网格留了边距和阴影,不能直接用 `source.svg`,否则 Dock 里会比别的应用大一圈 |
| `tray/source.svg` | `tray/macos/*.png`。菜单栏模板图:纯黑加透明,系统自动按深浅色着色,不能有别的颜色 |

## 重新生成

先把 SVG 渲染成 1024px PNG(任何能保留透明度的工具都行),然后:

```bash
pnpm tauri icon full-1024.png -o src-tauri/icons    # 会顺带生成一个 icon.icns,下面覆盖掉

mkdir mac.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s mac-1024.png --out mac.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) mac-1024.png --out mac.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns mac.iconset -o src-tauri/icons/icon.icns

sips -z 32 32 full-1024.png --out src/assets/icons/app-icon.png
```

托盘图保持原来 1024×962 / 72×68 的宽高比,菜单栏里的尺寸才不会变。
