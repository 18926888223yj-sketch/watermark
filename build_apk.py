# -*- coding: utf-8 -*-
"""
水印工坊 APK 构建脚本
工具链：JDK(javac/java) + aapt2 + android-all.jar(平台) + r8(d8) + apksig

用法： python build_apk.py
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(ROOT, "tools")
BUILD = os.path.join(ROOT, "build")
ANDROID = os.path.join(ROOT, "android")
WEB = os.path.join(ROOT, "web")
OUT = os.path.join(ROOT, "output")

JDK_DIR = os.path.join(TOOLS, "jdk")
AAPT2 = os.path.join(TOOLS, "aapt2", "aapt2.exe")
PLATFORM = os.path.join(TOOLS, "android-all.jar")
R8 = os.path.join(TOOLS, "r8.jar")
APKSIG = os.path.join(TOOLS, "apksig.jar")

PKG = "com.watermark.studio"
APP_NAME = "水印"
VERSION_NAME = "1.2.0"
VERSION_CODE = 2
MIN_SDK = 24
TARGET_SDK = 34

KS = os.path.join(TOOLS, "release.keystore")
KS_PASS = "watermark2026"
KS_ALIAS = "watermark"
KS_DN = "CN=Watermark Studio, OU=Mobile, O=Personal, L=Beijing, ST=Beijing, C=CN"


def log(*a):
    print(*a, flush=True)


def run(cmd, **kw):
    log("$", " ".join('"%s"' % c if " " in c else c for c in cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if p.stdout and p.stdout.strip():
        log(p.stdout.strip())
    if p.stderr and p.stderr.strip():
        log(p.stderr.strip())
    if p.returncode != 0:
        raise RuntimeError("命令失败(%d): %s" % (p.returncode, cmd[0]))
    return p


def java_exe(name):
    return os.path.join(JDK_DIR, "bin", name + ".exe")


# ---------------------------------------------------------------- 1. JDK
def ensure_jdk():
    if os.path.exists(java_exe("javac")):
        log("[1/8] JDK 已就绪")
        return
    zpath = os.path.join(TOOLS, "jdk17.zip")
    log("[1/8] 解压 JDK …")
    tmp = os.path.join(TOOLS, "_jdk_tmp")
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(tmp)
    subs = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d))]
    src = os.path.join(tmp, subs[0])
    if os.path.isdir(JDK_DIR):
        shutil.rmtree(JDK_DIR)
    shutil.move(src, JDK_DIR)
    shutil.rmtree(tmp, ignore_errors=True)
    run([java_exe("java"), "-version"])
    log("      JDK ->", JDK_DIR)


# ---------------------------------------------------------------- 2. 图标
def build_icon():
    log("[2/8] 生成应用图标 …")
    run([sys.executable, os.path.join(ROOT, "make_icon.py")])


# ---------------------------------------------------------------- 3. 资源
def link_resources():
    log("[3/8] aapt2 编译与链接资源 …")
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    os.makedirs(BUILD, exist_ok=True)
    res_zip = os.path.join(BUILD, "res.zip")
    run([AAPT2, "compile", "--dir", os.path.join(ANDROID, "res"), "-o", res_zip])
    base = os.path.join(BUILD, "base.apk")
    run([AAPT2, "link", "-o", base,
         "-I", PLATFORM,
         "--manifest", os.path.join(ANDROID, "AndroidManifest.xml"),
         res_zip,
         "--min-sdk-version", str(MIN_SDK),
         "--target-sdk-version", str(TARGET_SDK),
         "--version-code", str(VERSION_CODE),
         "--version-name", VERSION_NAME,
         "--no-version-vectors"])
    log("      base.apk 生成完成")
    return base


# ---------------------------------------------------------------- 4. Java
def compile_java():
    log("[4/8] javac 编译 Java 源码 …")
    src_dir = os.path.join(ANDROID, "java")
    sources = []
    for r, _d, fs in os.walk(src_dir):
        for f in fs:
            if f.endswith(".java"):
                sources.append(os.path.join(r, f))
    if not sources:
        raise RuntimeError("没有找到 Java 源码")
    classes = os.path.join(BUILD, "classes")
    os.makedirs(classes, exist_ok=True)
    cmd = [java_exe("javac"), "--release", "8", "-encoding", "UTF-8",
           "-nowarn", "-classpath", PLATFORM, "-d", classes] + sources
    try:
        run(cmd)
    except RuntimeError:
        log("      --release 8 失败，回退 -source/-target …")
        run([java_exe("javac"), "-source", "8", "-target", "8", "-encoding", "UTF-8",
             "-nowarn", "-classpath", PLATFORM, "-d", classes] + sources)
    return classes


# ---------------------------------------------------------------- 5. dex
def dex(classes):
    log("[5/8] d8 生成 classes.dex …")
    outs = []
    for r, _d, fs in os.walk(classes):
        for f in fs:
            if f.endswith(".class"):
                outs.append(os.path.join(r, f))
    dex_dir = os.path.join(BUILD, "dex")
    os.makedirs(dex_dir, exist_ok=True)
    run([java_exe("java"), "-cp", R8, "com.android.tools.r8.D8",
         "--min-api", str(MIN_SDK), "--lib", PLATFORM,
         "--output", dex_dir] + outs)
    d = os.path.join(dex_dir, "classes.dex")
    if not os.path.exists(d):
        raise RuntimeError("classes.dex 未生成")
    log("      classes.dex =", os.path.getsize(d), "bytes")
    return d


# ---------------------------------------------------------------- 6. 打包
def zip_write(path, entries):
    """entries: [(name, data, compress_bool)]，STORED 条目做 4 字节对齐（等价 zipalign -p 4）。"""
    ALIGN = 4
    DATE = 0x5821
    central = []
    offset = 0
    with open(path, "wb") as out:
        for name, data, compress in entries:
            nb = name.encode("utf-8")
            if compress:
                co = zlib.compressobj(9, zlib.DEFLATED, -15)
                cdata = co.compress(data) + co.flush()
                method = 8
            else:
                cdata = data
                method = 0
            crc = zlib.crc32(data) & 0xFFFFFFFF
            base = 30 + len(nb)
            padding = 0
            if method == 0 and ALIGN > 1:
                padding = (ALIGN - ((offset + base) % ALIGN)) % ALIGN
                if padding and padding < 4:
                    padding += ALIGN
            extra = b""
            if padding:
                extra = struct.pack("<HH", 0xD935, padding - 4) + b"\x00" * (padding - 4)
            out.write(struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, method, 0, DATE,
                                  crc, len(cdata), len(data), len(nb), len(extra)))
            out.write(nb)
            out.write(extra)
            out.write(cdata)
            central.append((name, nb, method, crc, len(cdata), len(data), offset, extra, DATE))
            offset += 30 + len(nb) + len(extra) + len(cdata)
        cd_start = offset
        for name, nb, method, crc, csize, usize, off, extra, date in central:
            out.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, method, 0, date,
                                  crc, csize, usize, len(nb), len(extra), 0, 0, 0, 0, off))
            out.write(nb)
            out.write(extra)
            offset += 46 + len(nb) + len(extra)
        cd_size = offset - cd_start
        out.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(central), len(central),
                              cd_size, cd_start, 0))


def assemble(base_apk, dex_file):
    log("[6/8] 组装 APK（资源 + dex + assets，4 字节对齐）…")
    entries = []
    with zipfile.ZipFile(base_apk) as z:
        for n in z.namelist():
            if n.endswith("/"):
                continue
            entries.append((n, z.read(n), n != "resources.arsc"))
    entries.append(("classes.dex", open(dex_file, "rb").read(), False))
    n_asset = 0
    for r, _d, fs in os.walk(WEB):
        for f in fs:
            p = os.path.join(r, f)
            rel = os.path.relpath(p, WEB).replace("\\", "/")
            entries.append(("assets/" + rel, open(p, "rb").read(), True))
            n_asset += 1
    # 排序：Android 建议按名称排序，dex/资源优先
    prio = {"classes.dex": 0, "resources.arsc": 1}
    entries.sort(key=lambda e: (prio.get(e[0], 2), e[0]))
    unsigned = os.path.join(BUILD, "unsigned.apk")
    zip_write(unsigned, entries)
    log("      条目数 =", len(entries), " assets =", n_asset,
        " 大小 =", os.path.getsize(unsigned))
    return unsigned


# ---------------------------------------------------------------- 7. 签名
SIGN_JAVA = r'''
import com.android.apksig.ApkSigner;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

public class SignApk {
    public static void main(String[] args) throws Exception {
        File ksFile = new File(args[0]);
        String pass = args[1];
        String alias = args[2];
        File in = new File(args[3]);
        File out = new File(args[4]);
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream fi = new FileInputStream(ksFile)) {
            ks.load(fi, pass.toCharArray());
        }
        PrivateKey pk = (PrivateKey) ks.getKey(alias, pass.toCharArray());
        X509Certificate cert = (X509Certificate) ks.getCertificate(alias);
        ApkSigner.SignerConfig sc = new ApkSigner.SignerConfig.Builder(
                "CERT", pk, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(sc))
                .setInputApk(in)
                .setOutputApk(out)
                .setV1SigningEnabled(true)
                .setV2SigningEnabled(true)
                .setV3SigningEnabled(false)
                .setMinSdkVersion(24)
                .build()
                .sign();
        System.out.println("SIGN_OK");
    }
}
'''

VERIFY_JAVA = r'''
import com.android.apksig.ApkVerifier;
import java.io.File;

public class VerifyApk {
    public static void main(String[] args) throws Exception {
        ApkVerifier.Result r = new ApkVerifier.Builder(new File(args[0]))
                .setMinCheckedPlatformVersion(24)
                .setMaxCheckedPlatformVersion(34)
                .build()
                .verify();
        System.out.println("VERIFIED=" + r.isVerified());
        System.out.println("V1=" + r.isVerifiedUsingV1Scheme());
        System.out.println("V2=" + r.isVerifiedUsingV2Scheme());
        System.out.println("V3=" + r.isVerifiedUsingV3Scheme());
        System.out.println("SIGNER=" + r.getSignerCertificates());
        if (!r.getAllErrors().isEmpty()) {
            System.out.println("ERRORS=" + r.getAllErrors());
        }
    }
}
'''


def ensure_keystore():
    if os.path.exists(KS):
        return
    log("      生成签名密钥库 …")
    run([java_exe("keytool"), "-genkeypair", "-v",
         "-keystore", KS, "-alias", KS_ALIAS,
         "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
         "-storetype", "PKCS12", "-storepass", KS_PASS, "-keypass", KS_PASS,
         "-dname", KS_DN])


def sign(unsigned):
    log("[7/8] 签名（v1 + v2）…")
    ensure_keystore()
    gen = os.path.join(BUILD, "signer_src")
    os.makedirs(gen, exist_ok=True)
    with open(os.path.join(gen, "SignApk.java"), "w", encoding="utf-8") as f:
        f.write(SIGN_JAVA)
    with open(os.path.join(gen, "VerifyApk.java"), "w", encoding="utf-8") as f:
        f.write(VERIFY_JAVA)
    cp = os.pathsep.join([APKSIG])
    run([java_exe("javac"), "-nowarn", "-encoding", "UTF-8", "-cp", cp, "-d", gen,
         os.path.join(gen, "SignApk.java"), os.path.join(gen, "VerifyApk.java")])
    out = os.path.join(OUT, "%s_v%s.apk" % (APP_NAME, VERSION_NAME))
    os.makedirs(OUT, exist_ok=True)
    run([java_exe("java"), "-cp", os.pathsep.join([gen, cp]), "SignApk",
         KS, KS_PASS, KS_ALIAS, unsigned, out])
    log("      已签名 ->", out)
    return out


# ---------------------------------------------------------------- 8. 校验
def verify(apk):
    log("[8/8] 校验 APK …")
    gen = os.path.join(BUILD, "signer_src")
    cp = os.pathsep.join([gen, APKSIG])
    run([java_exe("java"), "-cp", cp, "VerifyApk", apk])

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        need = ["AndroidManifest.xml", "classes.dex", "resources.arsc"]
        for n in need:
            assert n in names, "缺少 " + n
        assert "assets/index.html" in names, "缺少 assets/index.html"
        for n in names:
            if n.endswith(".dex"):
                data = z.read(n)
                assert data[:4] == b"dex\n", "dex 头不正确"
                assert data[4:7] in (b"035", b"036", b"037", b"038", b"039"), "dex 版本异常 " + repr(data[4:7])
        info = z.getinfo("resources.arsc")
        assert info.compress_type == zipfile.ZIP_STORED, "resources.arsc 必须未压缩"
        # 校验 4 字节对齐
        with open(apk, "rb") as f:
            raw = f.read()
        idx = raw.find(b"resources.arsc")
        off = raw.find(b"PK\x03\x04", max(0, idx - 200))
        # 直接读取本地头里的名字长度与额外长度
        hdr = raw[off:off + 30]
        nlen = struct.unpack("<H", hdr[26:28])[0]
        elen = struct.unpack("<H", hdr[28:30])[0]
        data_off = off + 30 + nlen + elen
        assert data_off % 4 == 0, "resources.arsc 未 4 字节对齐 (%d)" % data_off
        log("      AndroidManifest.xml 大小 =", z.getinfo("AndroidManifest.xml").file_size)
        log("      resources.arsc 对齐偏移 =", data_off, "(对齐 OK)")
        log("      dex 文件 =", [n for n in names if n.endswith(".dex")])
        # 检查二进制清单中的关键字符串
        man = z.read("AndroidManifest.xml")
        def has_str(s):
            return s.encode("utf-16-le") in man
        for s in ["com.watermark.studio", APP_NAME, "android.intent.action.MAIN",
                  "android.intent.category.LAUNCHER"]:
            log("      清单包含 %-32s : %s" % (s, has_str(s)))
    log("")
    log("构建成功 ✔  输出：", apk, " 大小 =", round(os.path.getsize(apk) / 1024.0, 1), "KB")


def main():
    ensure_jdk()
    build_icon()
    base = link_resources()
    classes = compile_java()
    dex_file = dex(classes)
    unsigned = assemble(base, dex_file)
    apk = sign(unsigned)
    verify(apk)


if __name__ == "__main__":
    main()
