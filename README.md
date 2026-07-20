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

- 四步分列：`query documentId` → `fetch uris (memory)` → `query display_name` → `query size`。
- 第五步：一次投影 `documentId + display_name + size` 合并 query，并打印 `sum of separate queries` 便于对比。
- 末尾样本：分列与 combined 各前 5 条。
- Logcat tag：`SafQueryTiming`。
- 对照：`android-kotlin-saf-documentfile-listfiles-demo`。

## 教程

1. **背景**：直接 query 可控制每次投影只带一列，方便对比单列成本。
2. **原理**：`buildChildDocumentsUriUsingTree` → 多次 `contentResolver.query` → 读 cursor 进数组。
3. **关键代码**：`MainActivity.runTimedQueryScan`。
