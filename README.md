# android-kotlin-saf-contentresolver-query-timing-demo

## 简介

用 `ContentResolver.query` + `DocumentsContract` 做与 DocumentFile Demo 对照的耗时测试：每个信息单独 query/遍历并计时；末尾各打前 5 条样本。

## 快速开始

### 环境要求

- JDK 17+
- Android SDK（compileSdk 35）
- 真机或模拟器

### 运行

```bash
./android-gradle-wrapper.mts
./android-build.mts
./android-adb.mts
```

## 注意事项

- 四步：`query documentId` → `fetch uris (memory)` → `query display_name` → `query size`（name/size 各单独一轮 query，不合并投影）。
- 内存可拿：已查出的 `documentId`、以及 `buildDocumentUriUsingTree` 拼出的 Uri。
- 末尾样本：`documentId` / `uris` / `names` / `sizes` 各前 5 条。
- Logcat tag：`SafQueryTiming`。
- 对照：`android-kotlin-saf-documentfile-listfiles-demo`。

## 教程

1. **背景**：直接 query 可控制每次投影只带一列，方便对比单列成本。
2. **原理**：`buildChildDocumentsUriUsingTree` → 多次 `contentResolver.query` → 读 cursor 进数组。
3. **关键代码**：`MainActivity.runTimedQueryScan`。
