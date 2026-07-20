# android-kotlin-saf-contentresolver-query-timing-demo

## 简介

用 `ContentResolver.query` + `DocumentsContract` 做与 DocumentFile Demo 对照的耗时测试：每个信息单独 query/遍历并计时；每步查完立刻打前 5 条样本。

字段来源（对照 DocumentFile）：

- **纯内存可读：无**。没有 `listFiles()` 那种「子项对象已在内存、uri 可直读」的模型。
- **必须 query 投影**：`documentId`、`display_name`、`size`、`mime_type`、`last_modified` 等 `DocumentsContract.Document` 列。
- **Uri**：只能用 `treeUri + documentId` 拼（`buildDocumentUriUsingTree`），不是 query 列，本 demo **不测**。

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

- 三步分列：`query documentId` → `query display_name` → `query size`。
- 第四步：一次投影 `documentId + display_name + size` 合并 query。
- 每步：开始前先 append「开始 …」→ 耗时 → 立刻打前 5 条；块间空一行。
- Logcat tag：`SafQueryTiming`。
- 对照：`android-kotlin-saf-documentfile-listfiles-demo`。

## 合并 query 为何不一定更快

直觉：分列三次 ≈ 扫目录三遍；合并一次投影 ≈ 扫一遍 → 应接近单列耗时，远小于三列之和。

实测若 **合并 ≈ 三列之和**（例如各 ~4s、合并 ~11s）：

1. 每次 `query` 都会让 DocumentsProvider 再枚举一遍子项；分列三次确实付了三次枚举。
2. **合并本应省掉后两次枚举**；若仍接近三倍，说明该 Provider/存储路径上「一次多列」没吃到「只枚举一次」的红利——常见原因：实现几乎无视 projection 优化、多列时每文件补 meta（尤其 size）更重、Cursor/Binder 传更多字段更慢、冷热缓存差异等。
3. 本 demo 就是用来对照这个现象；不同机型/目录（本地盘 vs 云盘 DocumentsProvider）结果可能差很多。

## 教程

1. **背景**：直接 query 可控制每次投影只带一列，方便对比单列成本。
2. **原理**：`buildChildDocumentsUriUsingTree` → 多次 `contentResolver.query` → 读 cursor 进数组。
3. **关键代码**：`MainActivity.runTimedQueryScan`。
