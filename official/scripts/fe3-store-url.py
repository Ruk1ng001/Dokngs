#!/usr/bin/env python3
"""解析 Microsoft Store 应用的真实包直链（MSIX/MSIXBUNDLE）。

背景：有些桌面客户端（如 ChatGPT desktop，Store 里的发布者是 OpenAI、
packageFamilyName 为 OpenAI.Codex_2p2nqsd0c76g0）官方只通过 Store 分发，
没有独立安装包直链。get.microsoft.com/installer/download/<ProductId> 拿到的
只是 1.4MB 的引导器（bootstrapper），真正负载仍旧从微软网络拉 —— 镜像它
起不到任何加速作用。要真正加速就必须拿到 Store 后端的包直链。

链路（全程匿名，无需 MSA 账号）：
  1. displaycatalog  ProductId → WuCategoryId + 版本号 + 包全名
  2. FE3 GetCookie              → 换取访问 cookie
  3. FE3 SyncUpdates(category)  → 该分类下的更新条目（UpdateID + RevisionNumber）
  4. FE3 GetExtendedUpdateInfo2 → 每个条目的 dl.delivery.mp.microsoft.com 直链

输出 JSON：{"version": "...", "packages": [{"name","arch","url","size"}]}

注意：FE3 返回的直链是带签名的短时效 URL（通常几十分钟），只能即时下载，
不能存进 manifest 给客户端用 —— 所以调用方必须「取链即下载」再上传到自己的
对象存储。

用法：
  fe3-store-url.py --product-id 9PLM9XGG6VKS [--arch x64,arm64] [--ring Retail]
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from xml.etree import ElementTree as ET

DISPLAYCATALOG = (
    "https://displaycatalog.mp.microsoft.com/v7.0/products/{pid}"
    "?languages=en-us&market=US&fieldsTemplate=Details"
)
FE3_OPEN = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx"
FE3_SECURED = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured"
WU_NS = "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"
TIMEOUT = 60


class FileInfo(NamedTuple):
    """SyncUpdates 的 <File> 条目：文件名、大小、摘要。

    GetExtendedUpdateInfo2 只回 Url + FileDigest，文件名/大小/算法全在这里，
    按 digest 关联。"""

    name: str
    size: str
    digest_b64: str
    algo: str

    def digest_hex(self) -> str:
        """base64 摘要转 hex，便于 shell 侧直接和 sha1sum 输出比对。"""
        try:
            return base64.b64decode(self.digest_b64).hex()
        except (ValueError, binascii.Error):
            return ""


# digest(base64) → FileInfo，由 sync_updates 填充，file_locations 回查。
FILES_BY_DIGEST: dict[str, FileInfo] = {}

# 真正的应用包后缀。同一个更新条目除了安装包还会返回附属文件（如
# Abm_*.cab 动态元数据，不到 1MB），按后缀过滤掉，别把它当安装包发出去。
PACKAGE_SUFFIXES = (".msix", ".msixbundle", ".appx", ".appxbundle")

# SyncUpdates 的「已装非叶子更新」白名单：不带这批 ID，服务端会把应用条目
# 当作前置条件未满足而过滤掉。这是 Store 客户端固定发送的一组公开常量。
INSTALLED_NON_LEAF = [
    "1", "2", "3", "11", "19",
    "2359974", "2359977", "5169044", "8788830", "23110993", "23110994",
    "59830006", "59830007", "59830008", "60484010", "62450018", "62450019",
    "62450020", "98959022", "98959023", "98959024", "98959025", "98959026",
    "129905029", "130040030", "130040031", "130040032", "130040033",
    "138372035", "138372036", "139536037", "139536038", "139536039",
    "139536040", "158941041", "158941042", "158941043", "158941044",
    "159123045", "159130046", "160733048", "160733049", "160733050",
    "160733051", "161870052", "168212054", "168212055", "168212056",
    "168212057",
]


def log(msg: str) -> None:
    print(f"[fe3] {msg}", file=sys.stderr)


# ---------- FE3 专用信任锚 ----------
#
# fe3.delivery.mp.microsoft.com 的证书链是
#   *.delivery.mp.microsoft.com ← Microsoft Update Secure Server CA 2.1
#                               ← Microsoft Root Certificate Authority 2011
# 这个根是 Windows Update 自己那套 PKI 的根，Windows 内置，但**不在**
# Debian/Ubuntu 的 ca-certificates 里（也不在多数 Linux 发行版里），所以
# Linux 上（含 GitHub ubuntu runner）默认必然 CERTIFICATE_VERIFY_FAILED。
# 相邻的 displaycatalog.mp.microsoft.com 走 DigiCert Global Root G2，
# 系统里有，所以同一个脚本里一半请求能成、一半不能 —— 不是本机 CA 库坏了。
#
# 处理办法：把这个根内嵌，只给 FE3 请求用一个专用 SSLContext。信任范围锁死在
# 这一个域，系统 CA store 不动，其它请求（displaycatalog、dl.delivery 下载）
# 一律照旧走系统信任。绝不用 verify=False：FE3 返回的是可执行安装包直链，
# 关掉校验等于给中间人留换包的口子。
MS_ROOT_CA_2011_PEM = """\
-----BEGIN CERTIFICATE-----
MIIF7TCCA9WgAwIBAgIQP4vItfyfspZDtWnWbELhRDANBgkqhkiG9w0BAQsFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMp
TWljcm9zb2Z0IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTEwHhcNMTEw
MzIyMjIwNTI4WhcNMzYwMzIyMjIxMzA0WjCBiDELMAkGA1UEBhMCVVMxEzARBgNV
BAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jv
c29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFJvb3QgQ2VydGlm
aWNhdGUgQXV0aG9yaXR5IDIwMTEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK
AoICAQCygEGqNThNE3IyaCJNuLLx/9VSvGzH9dJKjDbu0cJcfoyKrq8TKG/Ac+M6
ztAlqFo6be+ouFmrEyNozQwph9FvgFyPRH9dkAFSWKxRxV8qh9zc2AodwQO5e7BW
6KPeZGHCnvjzfLnsDbVU/ky2ZU+I8JxImQxCCwl8MVkXeQZ4KI2JOkwDJb5xalwL
54RgpJki49KvhKSn+9GY7Qyp3pSJ4Q6g3MDOmT3qCFK7VnnkH4S6Hri0xElcTzFL
h93dBWcmmYDgcRGjuKVB4qRTufcyKYMME782XgSzS0NHL2vikR7TmE/dQgfI6B0S
/Jmpaz6SfsjWaTr8ZL22CZ3K/QwLopt3YEsDlKQwaRLWQi3BQUzK3Kr9j1uDRprZ
/LHR47PJf0h6zSTwQY9cdNCssBAgBkm3xy0hyFfj0IbzA2j70M5xwYmZSmQBbP3s
MJHPQTySx+W6hh1hhMdfgzlirrSSL0fzC/hV66AfWdC7dJse0Hbm8ukG1xDo+mTe
acY1logC8Ea4PyeZb8txiSk190gWAjWP1Xl8TQLPX+uKg09FcYj5qQ1OcunCnAfP
SRtOBA5jUYxe2ADBVSy2xuDCZU7JNDn1nLPEfuhhbhNfFcRf2X7tHc7uROzLLoax
7Dj2cO2rXBPB2Q8Nx4CyVe0096yb5MPa50c8prWPMd/FS6/r8QIDAQABo1EwTzAL
BgNVHQ8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUci06AjGQQ7kU
BU7h6qfHMdEjiTQwEAYJKwYBBAGCNxUBBAMCAQAwDQYJKoZIhvcNAQELBQADggIB
AH9yzw+3xRXbm8BJyiZb/p4T5tPw0tuXX/JLP02zrhmu7deXoKzvqTqjwkGw5biR
nhOBJAPmCf0/V0A5ISRW0RAvS0CpNoZLtFNXmvvxfomPEf4YbFGq6O0JlbXlccmh
6Yd1phV/yX43VF50k8XDZ8wNT2uoFwxtCJJ+i92Bqi1wIcM9BhS7vyRep4TXPw8h
Ir1LAAbblxzYXtTFC1yHblCk6MM4pPvLLMWSZpuFXst6bJN8gClYW1e1QGm6CHmm
ZGIVnYeWRbVmIyADixxzoNOieTPgUFmG2y/lAiXqcyqfABTINseSO+lOAOzYVgm5
M0kS0lQLAausR7aRKX1MtHWAUgHoyoL2n8ysnI8X6i8msKtyrAv+nlEex0NVZ09R
s1fWtuzuUrc66U7h14GIvE+OdbtLqPA1qibUZ2dJsnBMO5PcHd94kIZysjik0dyS
TclY6ysSXNQ7roxrsIPlAT/4CTL2kzU0Iq/dNw13CYArzUgA8YyZGUcFAenRv9FO
0OYoQzeZpApKCNmacXPSqs0xE2N2oTdvkjgefRI8ZjLny23h/FKJ3crWZgWalmG+
oijHHKOnNlA8OqTfSm7mhzvO6/DggTedEzxSjr25HTTGHdUKaj2YKXCMiSrRq4IQ
SB/c9O+lxbtVGjhjhE63bK2VVOxlIhBJF7jAHscPrFRH
-----END CERTIFICATE-----
"""

# 上面那段 PEM 的 SHA-256 指纹（DER 编码的摘要，等同 openssl x509 -fingerprint
# -sha256）。写死是为了让「有人改了这段 PEM」变成启动即报错，而不是静默信任
# 一个来路不明的根。微软公布的 Root CA 2011 SHA-1 thumbprint 为
# 8F:43:28:8A:D2:72:F3:10:3B:6F:B1:42:84:85:EA:30:14:C0:BC:FE，可交叉核对。
MS_ROOT_CA_2011_SHA256 = "847df6a78497943f27fc72eb93f9a637320a02b561d0a91b09e87a7807ed7c61"

_fe3_ctx: ssl.SSLContext | None = None


def fe3_context() -> ssl.SSLContext:
    """给 FE3 端点用的 SSLContext：系统信任 + 内嵌的 MS Root CA 2011。"""
    global _fe3_ctx
    if _fe3_ctx is not None:
        return _fe3_ctx

    der = ssl.PEM_cert_to_DER_cert(MS_ROOT_CA_2011_PEM)
    got = hashlib.sha256(der).hexdigest()
    if got != MS_ROOT_CA_2011_SHA256:
        raise SystemExit(
            "内嵌的 Microsoft Root CA 2011 指纹不匹配，拒绝使用。\n"
            f"  期望 {MS_ROOT_CA_2011_SHA256}\n  实际 {got}"
        )

    # create_default_context() 已经装好系统信任（含主机名校验和证书链校验），
    # 这里只是在它之上再加一个根 —— 纯加法，不放宽任何校验。
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cadata=MS_ROOT_CA_2011_PEM)
    _fe3_ctx = ctx
    return ctx


def http(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict | None = None,
    context: ssl.SSLContext | None = None,
) -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=context) as resp:
        return resp.read()


def soap(url: str, body: str) -> ET.Element:
    try:
        raw = http(
            url,
            data=body.encode("utf-8"),
            headers={
                "Content-Type": "application/soap+xml; charset=utf-8",
                "User-Agent": "Windows-Update-Agent/10.0.10011.16384 Client-Protocol/2.31",
            },
            context=fe3_context(),
        )
    except urllib.error.HTTPError as exc:
        # SOAP fault 走 HTTP 500，真正的原因只在响应体里（如 a:InvalidSecurity）。
        # 不读出来的话上层只能看到「HTTP Error 500」，等于把唯一的线索丢了。
        raise SystemExit(f"FE3 SOAP 失败：{exc}{soap_fault(exc.read())}") from exc
    return ET.fromstring(raw)


def soap_fault(raw: bytes) -> str:
    """从 SOAP fault 响应体里抽出 subcode 和原因，抽不出就回原文（截断）。"""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return f"\n  响应体：{raw[:400]!r}"
    ns = "{http://www.w3.org/2003/05/soap-envelope}"
    parts = []
    sub = root.find(f".//{ns}Subcode/{ns}Value")
    if sub is not None and sub.text:
        parts.append(f"\n  Subcode：{sub.text}")
    reason = root.findtext(f".//{ns}Reason/{ns}Text")
    if reason:
        parts.append(f"\n  原因：{reason}")
    return "".join(parts) or f"\n  响应体：{raw[:400]!r}"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def security(now: datetime) -> str:
    """WS-Security 头。

    两个坑，都会表现为 HTTP 500 + Subcode a:InvalidSecurity（跟证书、参数无关）：

    1. 除了 Timestamp，还必须带一个 WindowsUpdateTicketsToken —— 匿名访问也要带，
       只是内容为空（不放 MSA/AAD 票据）。缺了它必失败。
    2. 这个 token 必须写成显式闭合 `<wuws:...></wuws:...>`，**不能**用自闭合
       `<wuws:... />`。两种写法 XML 语义完全等价，但服务端显然不是按 XML 解析的，
       自闭合一律被判 InvalidSecurity。已隔离验证：仅改这一处即 500 ↔ 200，
       属性换行缩进则无影响。改这行前请先复现，别当成格式问题「顺手清理」。"""
    return f"""<o:Security s:mustUnderstand="1"
        xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
        <Created>{iso(now)}</Created>
        <Expires>{iso(now + timedelta(minutes=5))}</Expires>
      </Timestamp>
      <wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA"
          xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
          xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization"></wuws:WindowsUpdateTicketsToken>
    </o:Security>"""


def find_all(node, key: str):
    """在任意嵌套的 dict/list 里递归收集某个键的全部取值。

    displaycatalog 的响应结构随 fieldsTemplate 和 SKU 数量变化，写死路径很脆，
    这里只按键名找。"""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                out.append(v)
            else:
                out.extend(find_all(v, key))
    elif isinstance(node, list):
        for v in node:
            out.extend(find_all(v, key))
    return out


# ---------- 第 1 步：displaycatalog ----------


def catalog_info(product_id: str) -> tuple[str, str]:
    """→ (wu_category_id, version)"""
    doc = json.loads(http(DISPLAYCATALOG.format(pid=product_id)))
    cats = [c for c in find_all(doc, "WuCategoryId") if isinstance(c, str) and c]
    if not cats:
        raise SystemExit(f"displaycatalog 未返回 WuCategoryId（ProductId={product_id}）")
    # 同一产品的多架构包共用一个 WuCategoryId，取第一个即可。
    category = cats[0]

    version = ""
    for name in find_all(doc, "PackageFullName"):
        if not isinstance(name, str):
            continue
        # 形如 OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0
        m = re.match(r"^[^_]+_(\d+(?:\.\d+)+)_", name)
        if m:
            version = m.group(1)
            break
    if not version:
        raise SystemExit(f"displaycatalog 未解析出版本号（ProductId={product_id}）")
    log(f"displaycatalog: category={category} version={version}")
    return category, version


# ---------- 第 2 步：GetCookie ----------


def get_cookie() -> str:
    now = datetime.now(timezone.utc)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>
    <a:Action s:mustUnderstand="1">{WU_NS}/GetCookie</a:Action>
    <a:MessageID>urn:uuid:{uuid.uuid4()}</a:MessageID>
    <a:To s:mustUnderstand="1">{FE3_OPEN}</a:To>
    {security(now)}
  </s:Header>
  <s:Body>
    <GetCookie xmlns="{WU_NS}">
      <lastChange>2015-10-21T17:01:07.1472913Z</lastChange>
      <currentTime>{iso(now)}</currentTime>
      <protocolVersion>1.40</protocolVersion>
    </GetCookie>
  </s:Body>
</s:Envelope>"""
    root = soap(FE3_OPEN, body)
    enc = root.find(f".//{{{WU_NS}}}EncryptedData")
    if enc is None or not enc.text:
        raise SystemExit("GetCookie 未返回 EncryptedData")
    log("GetCookie 成功")
    return enc.text


# ---------- 第 3 步：SyncUpdates ----------


def sync_updates(cookie: str, category: str, ring: str) -> list[tuple[str, str, str]]:
    """→ [(update_id, revision, package_moniker)]"""
    now = datetime.now(timezone.utc)
    installed = "".join(f"<int>{i}</int>" for i in INSTALLED_NON_LEAF)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>
    <a:Action s:mustUnderstand="1">{WU_NS}/SyncUpdates</a:Action>
    <a:MessageID>urn:uuid:{uuid.uuid4()}</a:MessageID>
    <a:To s:mustUnderstand="1">{FE3_OPEN}</a:To>
    {security(now)}
  </s:Header>
  <s:Body>
    <SyncUpdates xmlns="{WU_NS}">
      <cookie>
        <Expiration>2100-01-01T00:00:00Z</Expiration>
        <EncryptedData>{cookie}</EncryptedData>
      </cookie>
      <parameters>
        <ExpressQuery>false</ExpressQuery>
        <InstalledNonLeafUpdateIDs>{installed}</InstalledNonLeafUpdateIDs>
        <SkipSoftwareSync>false</SkipSoftwareSync>
        <NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>
        <FilterAppCategoryIds>
          <CategoryIdentifier><Id>{category}</Id></CategoryIdentifier>
        </FilterAppCategoryIds>
        <TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>
        <AlsoPerformRegularSync>false</AlsoPerformRegularSync>
        <ComputerSpec/>
        <ExtendedUpdateInfoParameters>
          <XmlUpdateFragmentTypes>
            <XmlUpdateFragmentType>Extended</XmlUpdateFragmentType>
            <XmlUpdateFragmentType>LocalizedProperties</XmlUpdateFragmentType>
            <XmlUpdateFragmentType>Eula</XmlUpdateFragmentType>
          </XmlUpdateFragmentTypes>
          <Locales><string>en-US</string><string>en</string></Locales>
        </ExtendedUpdateInfoParameters>
        <ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages>
        <ProductsParameters>
          <SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>
          <DeviceAttributes>BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;OEMModel=;FlightRing={ring};AttrDataVer=87;InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;ProcessorManufacturer=GenuineIntel;OSSkuId=48;App=WU_STORE;ProcessorIdentifier=Intel64%20Family%206%20Model%2063%20Stepping%202;OSArchitecture=AMD64;IsFlightingEnabled=1;IsDeviceRetailDemo=0;TelemetryLevel=3;OSVersion=10.0.22631.2861;DeviceFamily=Windows.Desktop;</DeviceAttributes>
          <CallerAttributes>E:Interactive=1&amp;IsSeeker=0&amp;Acquisition=1&amp;SheddingAware=1&amp;Id=Acquisition%3BMicrosoft.WindowsStore_8wekyb3d8bbwe;</CallerAttributes>
          <Products/>
        </ProductsParameters>
      </parameters>
    </SyncUpdates>
  </s:Body>
</s:Envelope>"""
    root = soap(FE3_OPEN, body)

    # 每个 <Update>/<Xml> 是一段**转义后**的 XML 文本，UpdateIdentity 和
    # PackageMoniker 都在这一段里。注意 UpdateIdentity 不是响应里的真实元素
    # （root.iter() 永远取不到，只能拿到 <Xml> 这个容器），所以必须先把 fragment
    # 的文本内容取出来再解析。UpdateID 与 moniker 同处一段，直接就地配对，
    # 不需要跨节点按数字 <ID> 关联。
    out: list[tuple[str, str, str]] = []
    seen_ids: set[str] = set()
    for frag in root.iter(f"{{{WU_NS}}}Xml"):
        # itertext() 拿的是转义解开后的原文；ET.tostring() 会保留 &lt; 转义，
        # 属性正则就匹配不上了。
        blob = "".join(frag.itertext())

        # 先收 <File> 表进全局索引：GetExtendedUpdateInfo2 只返回 URL + FileDigest，
        # 不给文件名和大小，得靠 digest 回查这里才知道哪个 URL 是真的安装包。
        # 这一步对所有 fragment 都要做，不能放在下面 moniker 的提前 continue 之后。
        for attrs in re.findall(r"<File\s+([^>]+?)/?>", blob):
            name = re.search(r'FileName="([^"]+)"', attrs)
            digest = re.search(r'Digest="([^"]+)"', attrs)
            if not name or not digest:
                continue
            size = re.search(r'Size="(\d+)"', attrs)
            algo = re.search(r'DigestAlgorithm="([^"]+)"', attrs)
            FILES_BY_DIGEST[digest.group(1)] = FileInfo(
                name=name.group(1),
                size=size.group(1) if size else "",
                digest_b64=digest.group(1),
                algo=(algo.group(1) if algo else "SHA1").upper(),
            )

        mon = re.search(r'PackageMoniker="([^"]+)"', blob)
        if not mon:
            continue
        ident = re.search(
            r'<UpdateIdentity\s+UpdateID="([^"]+)"\s+RevisionNumber="([^"]+)"', blob
        )
        if not ident:
            continue
        uid, rev = ident.group(1), ident.group(2)
        if uid in seen_ids:
            continue
        seen_ids.add(uid)
        out.append((uid, rev, mon.group(1)))

    log(f"SyncUpdates: {len(out)} 个带包名的条目")
    return out


# ---------- 第 4 步：GetExtendedUpdateInfo2 ----------


def file_locations(update_id: str, revision: str) -> list[tuple[str, FileInfo]]:
    """→ [(url, FileInfo)]，只含安装包本体（已剔除 cab 等附属文件）"""
    now = datetime.now(timezone.utc)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>
    <a:Action s:mustUnderstand="1">{WU_NS}/GetExtendedUpdateInfo2</a:Action>
    <a:MessageID>urn:uuid:{uuid.uuid4()}</a:MessageID>
    <a:To s:mustUnderstand="1">{FE3_SECURED}</a:To>
    {security(now)}
  </s:Header>
  <s:Body>
    <GetExtendedUpdateInfo2 xmlns="{WU_NS}">
      <updateIDs>
        <UpdateIdentity>
          <UpdateID>{update_id}</UpdateID>
          <RevisionNumber>{revision}</RevisionNumber>
        </UpdateIdentity>
      </updateIDs>
      <infoTypes>
        <XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType>
        <XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType>
      </infoTypes>
      <deviceAttributes>BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;OEMModel=;FlightRing=Retail;AttrDataVer=87;InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;OSSkuId=48;App=WU_STORE;OSArchitecture=AMD64;OSVersion=10.0.22631.2861;DeviceFamily=Windows.Desktop;</deviceAttributes>
    </GetExtendedUpdateInfo2>
  </s:Body>
</s:Envelope>"""
    root = soap(FE3_SECURED, body)
    out: list[tuple[str, FileInfo]] = []
    for loc in root.iter(f"{{{WU_NS}}}FileLocation"):
        url = loc.findtext(f"{{{WU_NS}}}Url", default="")
        # 同一条目可能返回多个 URL（含 emd: 加密分发的伪 URL），只要真实 HTTP 直链。
        if not url.startswith("http"):
            continue
        # 这里只给 Url + FileDigest，没有文件名也没有大小。一个应用条目会返回
        # 多个文件：真正的 .msix 安装包，以及 Abm_*.cab（约 0.9MB 的动态元数据）。
        # 光看 URL 分不出来（都是 filestreamingservice/files/<guid> 形态），必须用
        # digest 回查 SyncUpdates 的 <File> 表拿文件名和大小 —— 否则可能把那个
        # cab 当安装包传上去。
        digest = loc.findtext(f"{{{WU_NS}}}FileDigest", default="")
        info = FILES_BY_DIGEST.get(digest)
        if info is None or not info.name:
            continue
        if not info.name.lower().endswith(PACKAGE_SUFFIXES):
            continue
        out.append((url, info))
    return out


# ---------- 主流程 ----------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--product-id", required=True, help="Store ProductId，如 9PLM9XGG6VKS")
    ap.add_argument("--arch", default="x64,arm64", help="逗号分隔，默认 x64,arm64")
    ap.add_argument("--ring", default="Retail", help="FlightRing，默认 Retail")
    args = ap.parse_args()

    want = [a.strip().lower() for a in args.arch.split(",") if a.strip()]
    category, version = catalog_info(args.product_id)

    try:
        cookie = get_cookie()
        entries = sync_updates(cookie, category, args.ring)
    except urllib.error.URLError as exc:
        raise SystemExit(f"FE3 请求失败（网络不可达/TLS 握手失败）：{exc}") from exc

    packages = []
    seen = set()
    for uid, rev, moniker in entries:
        low = moniker.lower()
        # 只要主包，跳过运行时框架依赖（VCLibs / WindowsAppRuntime 等）。
        if any(dep in low for dep in ("vclibs", "windowsappruntime", "netcore", "ui.xaml")):
            continue
        arch = next((a for a in want if f"_{a}_" in low or f".{a}." in low), "")
        if not arch:
            continue
        if not low.endswith(PACKAGE_SUFFIXES) and "_" not in low:
            continue
        for url, info in file_locations(uid, rev):
            if url in seen:
                continue
            seen.add(url)
            packages.append(
                {
                    "name": moniker,
                    "arch": arch,
                    "url": url,
                    "size": info.size,
                    "filename": info.name,
                    # FE3 只给明文 http 直链（https 上是 Fastly 回落证书，主机名
                    # 对不上），所以完整性只能靠这个摘要兜底 —— 调用方下载后必须核。
                    "digest": info.digest_hex(),
                    "digest_algo": info.algo,
                }
            )

    if not packages:
        raise SystemExit(
            "未解析出任何包直链（可能是 FilterAppCategoryIds 无结果，或该产品未在 Retail 环上）"
        )

    json.dump({"version": version, "packages": packages}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    log(f"共 {len(packages)} 个包直链")
    return 0


if __name__ == "__main__":
    sys.exit(main())
