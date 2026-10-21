package com.watermark.studio;

import android.app.Activity;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * JS <-> 原生桥接。图片以分块 Base64 传输，避免超大字符串导致内存问题。
 */
public class Bridge {

    private final Activity act;
    private byte[] buf;
    private int off;
    private String fname;
    private String fmime;

    Bridge(Activity a) {
        this.act = a;
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    /**
     * 原生选图：打开系统图片选择器（可多选）。
     * 结果通过 window.__onNativePicked(kind, json) 回调，
     * 图片以 https://app.local/__pick__/token 形式提供原始字节流。
     */
    @JavascriptInterface
    public void pickImages(final String kind) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (act instanceof MainActivity) ((MainActivity) act).startPick(kind);
                } catch (Throwable ignored) { }
            }
        });
    }

    @JavascriptInterface
    public void beginSave(String name, String mime, int total, int chunks) {
        fname = (name == null || name.length() == 0) ? ("watermark_" + System.currentTimeMillis() + ".jpg") : name;
        fmime = (mime == null || mime.length() == 0) ? "image/jpeg" : mime;
        buf = new byte[Math.max(total, 1)];
        off = 0;
    }

    @JavascriptInterface
    public void saveChunk(String b64) {
        if (buf == null || b64 == null) return;
        try {
            byte[] d = Base64.decode(b64, Base64.DEFAULT);
            if (off + d.length > buf.length) {
                byte[] nb = new byte[Math.max(off + d.length, buf.length * 2)];
                System.arraycopy(buf, 0, nb, 0, off);
                buf = nb;
            }
            System.arraycopy(d, 0, buf, off, d.length);
            off += d.length;
        } catch (Throwable ignored) { }
    }

    @JavascriptInterface
    public String endSave() {
        if (buf == null) return "no data";
        byte[] data;
        try {
            data = new byte[off];
            System.arraycopy(buf, 0, data, 0, off);
        } finally {
            buf = null;
        }
        try {
            return writeToGallery(data, fname, fmime);
        } catch (Throwable t) {
            return "error: " + t.getClass().getSimpleName() + " " + t.getMessage();
        }
    }

    /** 写入系统相册，目录：Pictures/水印工坊 */
    private String writeToGallery(byte[] data, String name, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
            cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/水印");
            cv.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = act.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) return "insert failed";
            OutputStream os = act.getContentResolver().openOutputStream(uri);
            if (os == null) return "open failed";
            os.write(data);
            os.flush();
            os.close();
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            act.getContentResolver().update(uri, done, null, null);
            return "ok";
        }
        if (act.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            return "need_permission";
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "水印");
        if (!dir.exists() && !dir.mkdirs()) return "mkdir failed";
        File f = new File(dir, name);
        FileOutputStream fo = new FileOutputStream(f);
        fo.write(data);
        fo.flush();
        fo.close();
        MediaScannerConnection.scanFile(act, new String[]{f.getAbsolutePath()}, new String[]{mime}, null);
        return "ok";
    }

    @JavascriptInterface
    public void showToast(final String msg) {
        if (msg == null) return;
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Toast.makeText(act, msg, Toast.LENGTH_SHORT).show();
                } catch (Throwable ignored) { }
            }
        });
    }
}
