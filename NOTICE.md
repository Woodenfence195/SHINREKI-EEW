# NOTICE / 数据来源与第三方权利

震歴 SHINREKI 的**源代码**以 MIT 许可发布（见 `LICENSE`）。
仓库中包含的地图派生数据、以及程序在运行过程中读取的公开数据，**不属于** MIT 许可范围，
其权利归各提供者所有，使用条件如下。若你分发本仓库（含派生数据），请保留本文件与下列署名。

---

## 1. 地图几何（随仓库分发）

文件：

- `web/data/japan.json` —— 47 都道府县简化边界（GeoJSON）
- `app/assets/prefmap.bin` —— 上述边界按 NIED 栅格投影栅格化得到的 352×400 陆地索引
- `tools/prefs_simplified.json` —— 简化过程中的中间文件

来源：**地球地図日本**（国土地理院 / Geospatial Information Authority of Japan）
<https://www.gsi.go.jp/kankyochiri/gm_jpn.html>
经 <https://github.com/dataofjapan/land> 转换（`japan.geojson`）后再做简化。

使用条件（依照配布元）：

- **非营利目的**：注明出处「地球地図日本（国土地理院）」；
- **营利目的**：注明出处，**并向国土地理院提交利用报告**。

> 本项目仅对几何做了抽稀/裁切，未改变地理含义。

## 2. 实时震度数据与色标（运行时不重分发）

- 数据：**防災科学技術研究所（NIED）強震モニタ** 实时震度栅格
  <https://www.kyoshin.bosai.go.jp/> → `www.kmoni.bosai.go.jp`
- `app/assets/legend.json`：从该站公开的震度色标图采样得到的 **271 级颜色-震度对照**，
  仅用于把公开栅格的像素颜色反解为震度数值。它不是原始数据、也不包含 NIED 的代码。

程序运行时会以 1 Hz 拉取公开图像到本机内存/本地数据库，**仓库本身不包含任何历史震度数据**。

## 3. 速报 / 地震情报 / 津波 / 长周期地震动（运行时读取）

- **P2PQuake**（`api.p2pquake.net`）：緊急地震速報・地震情報・津波情報的公开转发，
  <https://www.p2pquake.net/>
- **気象庁 防災情報XML**（`www.data.jma.go.jp/developer/xml/`）：
  震源・震度情報（VXSE53）、長周期地震動（VXSE61/62），
  <https://www.data.jma.go.jp/developer/xml/>

这些数据受各提供者的利用条款约束；本项目只做展示，不重分发原始报文。

## 4. 其他

- 界面图形（SVG 图标、Canvas 绘制、配色）为本项目原创。
- 警报音由 Web Audio 实时合成，不含任何采样音频。
- 未内置任何字体文件，使用系统字体（Microsoft YaHei UI / Cascadia Mono 等）。
- 未使用 JQuake（闭源）的任何代码或资源；KyoshinEewViewer 仅作为功能参照，未复制其代码。

## 5. 免责声明

本项目与国土地理院、防災科学技術研究所、気象庁、P2PQuake 均无隶属或背书关系。
地震速报、震度、津波、长周期情报均存在延迟与误差，**不可用于防灾决策、避难判断或商业告警服务**。
使用本项目产生的一切后果由使用者自行承担。
