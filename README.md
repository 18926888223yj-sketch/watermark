# WatermarkApp · 图片水印工具

一个纯前端的图片水印工具，支持 Web 与 Android（WebView 封装）两端运行。

## 下载安装

**[⬇ 下载 Android APK（v1.2.0）](https://github.com/18926888223yj-sketch/watermark/releases/download/v1.2.0/watermark-v1.2.0.apk)**

支持 Android 7.0 及以上，约 73 KB。安装时需允许「安装未知来源应用」。
更多版本见 [Releases](https://github.com/18926888223yj-sketch/watermark/releases)。

## 功能

- **文字水印**：自定义内容、字号、颜色、透明度、旋转角度
- **平铺 / 单个** 两种排布模式
- **编辑器**：可视化拖拽定位、实时预览
- 全部处理在本地浏览器完成，图片不上传服务器

## 目录结构

```
WatermarkApp/
├── web/                 # 前端页面（核心代码）
│   ├── index.html       # 页面结构
│   ├── style.css        # 样式
│   └── app.js           # 水印渲染与交互逻辑
├── android/             # Android 外壳工程
│   ├── AndroidManifest.xml
│   ├── java/            # WebView 容器 Java 源码
│   └── res/             # 图标与资源
├── build_apk.py         # APK 一键打包脚本
├── make_icon.py         # 应用图标生成脚本
└── icon_src.png         # 图标源图
```

## 本地运行

`web/` 是纯静态页面，直接用浏览器打开 `web/index.html` 即可，无需构建、无依赖。

## 打包 Android APK

需要本机具备 JDK 与 Android SDK 构建工具（脚本会自动使用 `tools/` 下的工具链，该目录不纳入版本控制）。

```bash
python build_apk.py
```

产物输出到 `output/` 目录。

## 说明

- `tools/`（构建工具链）、`build/`、`output/` 及签名文件均已通过 `.gitignore` 排除，请勿提交。
- 签名密钥需自行保管，不要上传到公开仓库。

## License

MIT
