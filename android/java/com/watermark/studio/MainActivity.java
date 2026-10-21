package com.watermark.studio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 水印 —— 本地 WebView 外壳。
 * 页面全部来自 assets，通过 https://app.local/ 伪域名提供，
 * 以获得安全来源（IndexedDB / localStorage 可持久化）。
 *
 * 图片选择提供两条通道：
 *  1) 原生通道（主）：Bridge.pickImages() -> 系统文档选择器 -> 选中文件通过
 *     https://app.local/__pick__/<token> 以原始字节流交给网页（不压缩、不转码）
 *  2) WebView 通道（备）：<input type=file> -> onShowFileChooser
 */
public class MainActivity extends Activity {

    private static final String HOST = "app.local";
    private static final String BASE = "https://" + HOST + "/";
    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;
    private static final int REQ_PICK = 1003;

    private static final String PICK_PREFIX = "/__pick__/";
    /** token -> 系统返回的 content Uri（后台线程读取，故用并发容器） */
    private static final Map<String, Uri> PICKED = new java.util.concurrent.ConcurrentHashMap<String, Uri>();

    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private String pickKind;
    private int tokenSeq = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#14161F"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadsImagesAutomatically(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        web.addJavascriptInterface(new Bridge(this), "AndroidBridge");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT < 29) {
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM);
            }
        }

        web.loadUrl(BASE + "index.html");
    }

    /* ---------------- 资源拦截：把 assets 映射到 https://app.local/ ---------------- */
    private class LocalClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u == null || !HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";

            // 选中的本地图片：以原始字节流返回（避免 Base64 造成的内存峰值）
            if (path.startsWith(PICK_PREFIX)) {
                String token = path.substring(PICK_PREFIX.length());
                Uri src = PICKED.get(token);
                if (src == null) return notFound();
                try {
                    InputStream in = getContentResolver().openInputStream(src);
                    if (in == null) return notFound();
                    String type = getContentResolver().getType(src);
                    if (type == null || !type.startsWith("image/")) type = "application/octet-stream";
                    return new WebResourceResponse(type, null, 200, "OK",
                            new HashMap<String, String>(), in);
                } catch (Throwable t) {
                    return notFound();
                }
            }

            String name = path.startsWith("/") ? path.substring(1) : path;
            if (name.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open(name);
                return new WebResourceResponse(mimeOf(name), "UTF-8", in);
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u != null && HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) { }
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        Map<String, String> h = new HashMap<String, String>();
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", h,
                new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.US);
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    /* ---------------- 通道 1：原生选图（由 JS 主动调用） ---------------- */
    void startPick(String kind) {
        pickKind = (kind == null || kind.length() == 0) ? "photo" : kind;
        PICKED.clear();          // 释放上一次选择占用的 Uri 引用
        // 优先 ACTION_OPEN_DOCUMENT（可多选、无需存储权限）
        Intent doc = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        doc.addCategory(Intent.CATEGORY_OPENABLE);
        doc.setType("image/*");
        doc.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        doc.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (launch(doc)) return;

        Intent get = new Intent(Intent.ACTION_GET_CONTENT);
        get.addCategory(Intent.CATEGORY_OPENABLE);
        get.setType("image/*");
        get.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        get.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (launch(get)) return;

        Intent any = new Intent(Intent.ACTION_GET_CONTENT);
        any.setType("image/*");
        any.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        if (!launch(any)) notifyPicked(null);
    }

    private boolean launch(Intent i) {
        try {
            startActivityForResult(i, REQ_PICK);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private void notifyPicked(final String json) {
        final String kind = (pickKind == null) ? "photo" : pickKind;
        pickKind = null;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                String js = "window.__onNativePicked&&window.__onNativePicked(" + jstr(kind) + ","
                        + (json == null ? "null" : jstr(json)) + ")";
                try {
                    web.evaluateJavascript(js, null);
                } catch (Throwable ignored) { }
            }
        });
    }

    private static String jstr(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append("\"").toString();
    }

    private String displayName(Uri u) {
        String n = null;
        Cursor c = null;
        try {
            c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !c.isNull(idx)) n = c.getString(idx);
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) {
                try { c.close(); } catch (Throwable ignored) { }
            }
        }
        if (n == null || n.length() == 0) {
            String seg = (u.getLastPathSegment() == null) ? "image" : u.getLastPathSegment().replace('/', '_');
            n = seg.indexOf('.') < 0 ? (seg + ".jpg") : seg;
        }
        return n;
    }

    /* ---------------- 通道 2：WebView <input type=file>（后备） ---------------- */
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCb != null) {
                try { fileCb.onReceiveValue(null); } catch (Throwable ignored) { }
                fileCb = null;
            }
            fileCb = cb;

            String[] accept = null;
            int mode = 0;
            try {
                accept = params.getAcceptTypes();
                mode = params.getMode();
            } catch (Throwable ignored) { }

            Intent i = null;
            try {
                i = params.createIntent();
            } catch (Throwable ignored) { }
            if (i == null) i = new Intent(Intent.ACTION_GET_CONTENT);
            try { i.addCategory(Intent.CATEGORY_OPENABLE); } catch (Throwable ignored) { }
            i.setType(pickMime(accept));
            if (mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (launchChooser(i)) return true;

            Intent g = new Intent(Intent.ACTION_GET_CONTENT);
            g.setType(pickMime(accept));
            g.addCategory(Intent.CATEGORY_OPENABLE);
            if (mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                g.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            if (launchChooser(g)) return true;

            fileCb = null;
            return false;
        }

        private boolean launchChooser(Intent i) {
            try {
                startActivityForResult(i, REQ_FILE);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    }

    private static String pickMime(String[] accept) {
        if (accept == null || accept.length == 0) return "image/*";
        for (String a : accept) {
            if (a != null && a.length() > 0) return a;
        }
        return "image/*";
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (fileCb != null) {
                Uri[] r = null;
                try {
                    r = WebChromeClient.FileChooserParams.parseResult(res, data);
                } catch (Throwable ignored) { }
                if (r == null && data != null) {
                    // 部分 ROM 不走标准结果格式，自行兜底解析
                    List<Uri> one = collect(data);
                    if (!one.isEmpty()) r = new Uri[]{one.get(0)};
                }
                try { fileCb.onReceiveValue(r); } catch (Throwable ignored) { }
                fileCb = null;
            }
            return;
        }
        if (req == REQ_PICK) {
            List<Uri> uris = (data == null) ? new ArrayList<Uri>() : collect(data);
            if (uris.isEmpty()) {
                notifyPicked(null);
                return;
            }
            StringBuilder arr = new StringBuilder("[");
            for (int i = 0; i < uris.size(); i++) {
                Uri u = uris.get(i);
                String token = "t" + (tokenSeq++) + System.currentTimeMillis();
                PICKED.put(token, u);
                String type = null;
                try { type = getContentResolver().getType(u); } catch (Throwable ignored) { }
                if (type == null || !type.startsWith("image/")) type = guessType(displayName(u));
                if (i > 0) arr.append(',');
                arr.append("{\"name\":").append(jstr(displayName(u)))
                        .append(",\"type\":").append(jstr(type))
                        .append(",\"url\":").append(jstr(BASE + "__pick__/" + token))
                        .append('}');
            }
            arr.append(']');
            notifyPicked(arr.toString());
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /** 从返回 Intent 中尽可能收集 Uri（clipData 多选 / data 单选 / clipData 单选） */
    private static List<Uri> collect(Intent data) {
        List<Uri> out = new ArrayList<Uri>();
        try {
            ClipData cd = data.getClipData();
            if (cd != null) {
                for (int i = 0; i < cd.getItemCount(); i++) {
                    ClipData.Item it = cd.getItemAt(i);
                    Uri u = (it == null) ? null : it.getUri();
                    if (u != null && !out.contains(u)) out.add(u);
                }
            }
            Uri d = data.getData();
            if (d != null && !out.contains(d)) out.add(d);
        } catch (Throwable ignored) { }
        return out;
    }

    private static String guessType(String name) {
        String n = (name == null) ? "" : name.toLowerCase(Locale.US);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".bmp")) return "image/bmp";
        if (n.endsWith(".heic")) return "image/heic";
        if (n.endsWith(".heif")) return "image/heif";
        if (n.endsWith(".avif")) return "image/avif";
        return "image/jpeg";
    }

    /* ---------------- 返回键 ---------------- */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){try{return window.__onAndroidBack?window.__onAndroidBack():false}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) finish();
                    }
                });
    }
}
