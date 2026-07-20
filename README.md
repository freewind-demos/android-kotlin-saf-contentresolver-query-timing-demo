# android-kotlin-saf-contentresolver-query-timing-demo

## 简介

与 DocumentFile 耗时 Demo 同结构：选目录后四步计时，但改用 `ContentResolver.query` + `DocumentsContract`。界面只报动作、条数、ms。

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

- 四步：`query list (documentId)` → `fetch all uris`（本地 `buildDocumentUriUsingTree`）→ `query all names` → `query all sizes`。
- names / sizes 各再打一次 children `query`，投影里只带对应列。
- Logcat tag：`SafQueryTiming`。
- 可对照：`android-kotlin-saf-documentfile-listfiles-demo`。

## 教程

1. **背景**：`DocumentFile.listFiles` 底层也是 query；直接 query 可自己控制投影与次数。
2. **原理**：`buildChildDocumentsUriUsingTree` → `contentResolver.query` → 读 cursor 进数组。
3. **关键代码**：`MainActivity.runTimedQueryScan`。
