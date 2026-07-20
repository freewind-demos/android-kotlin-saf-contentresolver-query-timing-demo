package com.freewind.saf.querytiming

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.DocumentsContract
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * SAF + ContentResolver.query 耗时 Demo。
 *
 * 每个信息单独 query/遍历计时（对照 DocumentFile Demo）：
 * 各大操作开始前先 append「开始 …」，块间空一行；
 * 1) query documentId → 紧接前 5 条
 * 2) 内存拼 uri（不访问 FS）→ 紧接前 5 条
 * 3) 单独 query display_name → 紧接前 5 条
 * 4) 单独 query size → 紧接前 5 条
 * 5) 合并 query → 紧接前 5 条
 */
class MainActivity : ComponentActivity() {

    // Logcat 过滤用
    private val tag = "SafQueryTiming"

    // 用户选中的目录树 Uri
    private var treeUri by mutableStateOf<Uri?>(null)

    // 耗时与样本日志
    private var outputText by mutableStateOf("先点「选择目录」，再点「扫描」看耗时。")

    private var scanning by mutableStateOf(false)

    private var scanJob: Job? = null

    private val openTree =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri == null) {
                outputText = "未选择目录（用户取消）。"
                Log.i(tag, "OpenDocumentTree cancelled")
                return@registerForActivityResult
            }
            val flags =
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, flags)
            treeUri = uri
            outputText = "已选目录。\n点「扫描」开始 ContentResolver.query 计时。"
            Log.i(tag, "treeUri selected")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = "android-kotlin-saf-contentresolver-query-timing-demo",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            text = "分列单独 query 计时，每步查完立刻打前 5 条；" +
                                "再一次把 documentId+name+size 合并 query 对比。",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(
                            onClick = { openTree.launch(null) },
                            enabled = !scanning,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("选择目录")
                        }
                        Button(
                            onClick = { startScan() },
                            enabled = treeUri != null && !scanning,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (scanning) "扫描中…" else "扫描")
                        }
                        Text(
                            text = outputText,
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                                .verticalScroll(rememberScrollState()),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        scanJob?.cancel()
        super.onDestroy()
    }

    private fun startScan() {
        val uri = treeUri
            ?: error("未选择目录却触发了扫描")
        scanning = true
        outputText = "扫描开始…"
        scanJob?.cancel()
        scanJob = CoroutineScope(Dispatchers.Main.immediate).launch {
            try {
                runTimedQueryScan(uri)
                appendLine("done")
            } catch (e: Exception) {
                val msg = "扫描失败: ${e.message}"
                appendLine(msg)
                Log.e(tag, msg, e)
            } finally {
                scanning = false
            }
        }
    }

    /**
     * 1~4) 分列：单独 query documentId / 内存拼 uri / query name / query size。
     * 5) 再一次：同一轮投影带上 documentId + display_name + size，对比合并 query 耗时。
     */
    private suspend fun runTimedQueryScan(treeUri: Uri) {
        val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)

        // —— 1) 单独 query：documentId ——
        appendLine("开始 query documentId …")
        val listStarted = SystemClock.elapsedRealtime()
        val documentIds = withContext(Dispatchers.IO) {
            queryColumnStrings(
                childrenUri,
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            )
        }
        val listMs = SystemClock.elapsedRealtime() - listStarted
        appendLine("query documentId: ${documentIds.size} items, ${listMs} ms")
        appendSample("documentId", documentIds.map { it ?: "null" })
        appendLine("")

        // —— 2) 内存拼 uri ——
        appendLine("开始 fetch all uris (memory) …")
        val urisStarted = SystemClock.elapsedRealtime()
        val uris = withContext(Dispatchers.IO) {
            ArrayList<Uri>(documentIds.size).also { out ->
                for (docId in documentIds) {
                    val id = docId ?: error("documentId 为 null，无法拼 Uri")
                    out.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, id))
                }
            }
        }
        val urisMs = SystemClock.elapsedRealtime() - urisStarted
        appendLine("fetch all uris (memory): ${uris.size} items, ${urisMs} ms")
        appendSample("uris", uris.map { it.toString() })
        appendLine("")

        // —— 3) 单独 query：display_name ——
        appendLine("开始 query display_name …")
        val namesStarted = SystemClock.elapsedRealtime()
        val names = withContext(Dispatchers.IO) {
            queryColumnStrings(
                childrenUri,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            )
        }
        val namesMs = SystemClock.elapsedRealtime() - namesStarted
        appendLine("query display_name: ${names.size} items, ${namesMs} ms")
        appendSample("names", names.map { it ?: "null" })
        appendLine("")

        // —— 4) 单独 query：size ——
        appendLine("开始 query size …")
        val sizesStarted = SystemClock.elapsedRealtime()
        val sizes = withContext(Dispatchers.IO) {
            queryColumnLongs(
                childrenUri,
                DocumentsContract.Document.COLUMN_SIZE,
            )
        }
        val sizesMs = SystemClock.elapsedRealtime() - sizesStarted
        appendLine("query size: ${sizes.size} items, ${sizesMs} ms")
        appendSample("sizes", sizes.map { it?.toString() ?: "null" })
        appendLine("")

        // 分列合计（便于和合并 query 对比；不含内存拼 uri）
        val separateQuerySumMs = listMs + namesMs + sizesMs
        appendLine("sum of separate queries (id+name+size): ${separateQuerySumMs} ms")
        appendLine("")

        // —— 5) 合并一次 query：documentId + display_name + size ——
        appendLine("开始 query combined (id+name+size) …")
        val combinedStarted = SystemClock.elapsedRealtime()
        val combined = withContext(Dispatchers.IO) {
            queryCombinedIdNameSize(childrenUri)
        }
        val combinedMs = SystemClock.elapsedRealtime() - combinedStarted
        appendLine(
            "query combined (id+name+size): ${combined.ids.size} items, ${combinedMs} ms",
        )
        appendSample("combined.documentId", combined.ids.map { it ?: "null" })
        appendSample("combined.names", combined.names.map { it ?: "null" })
        appendSample("combined.sizes", combined.sizes.map { it?.toString() ?: "null" })
    }

    /** 一次 query 同时投影 documentId / display_name / size，读进三组数组。 */
    private fun queryCombinedIdNameSize(childrenUri: Uri): CombinedRows {
        val idCol = DocumentsContract.Document.COLUMN_DOCUMENT_ID
        val nameCol = DocumentsContract.Document.COLUMN_DISPLAY_NAME
        val sizeCol = DocumentsContract.Document.COLUMN_SIZE
        val projection = arrayOf(idCol, nameCol, sizeCol)
        val cursor = contentResolver.query(childrenUri, projection, null, null, null)
            ?: error("contentResolver.query 返回 null, uri=$childrenUri, combined projection")
        return cursor.use { c ->
            val idIndex = c.getColumnIndexOrThrow(idCol)
            val nameIndex = c.getColumnIndexOrThrow(nameCol)
            val sizeIndex = c.getColumnIndexOrThrow(sizeCol)
            val ids = ArrayList<String?>(c.count)
            val names = ArrayList<String?>(c.count)
            val sizes = ArrayList<Long?>(c.count)
            while (c.moveToNext()) {
                ids.add(if (c.isNull(idIndex)) null else c.getString(idIndex))
                names.add(if (c.isNull(nameIndex)) null else c.getString(nameIndex))
                sizes.add(if (c.isNull(sizeIndex)) null else c.getLong(sizeIndex))
            }
            CombinedRows(ids = ids, names = names, sizes = sizes)
        }
    }

    /** 合并 query 读出的三列。 */
    private data class CombinedRows(
        val ids: ArrayList<String?>,
        val names: ArrayList<String?>,
        val sizes: ArrayList<Long?>,
    )

    /**
     * 对 childrenUri 做一次单列 query，读进 ArrayList。
     * cursor 为 null → 报错（禁 silent fallback）。
     */
    private fun queryColumnStrings(childrenUri: Uri, column: String): ArrayList<String?> {
        val projection = arrayOf(column)
        val cursor = contentResolver.query(childrenUri, projection, null, null, null)
            ?: error("contentResolver.query 返回 null, uri=$childrenUri, column=$column")
        return cursor.use { c ->
            val index = c.getColumnIndexOrThrow(column)
            ArrayList<String?>(c.count).also { out ->
                while (c.moveToNext()) {
                    out.add(if (c.isNull(index)) null else c.getString(index))
                }
            }
        }
    }

    /** 单列 query，读 Long（SIZE）；null 仍占一条。 */
    private fun queryColumnLongs(childrenUri: Uri, column: String): ArrayList<Long?> {
        val projection = arrayOf(column)
        val cursor = contentResolver.query(childrenUri, projection, null, null, null)
            ?: error("contentResolver.query 返回 null, uri=$childrenUri, column=$column")
        return cursor.use { c ->
            val index = c.getColumnIndexOrThrow(column)
            ArrayList<Long?>(c.count).also { out ->
                while (c.moveToNext()) {
                    out.add(if (c.isNull(index)) null else c.getLong(index))
                }
            }
        }
    }

    /** 某数组前 5 条样本。 */
    private fun appendSample(label: String, values: List<String>) {
        appendLine("--- sample $label (first 5) ---")
        val n = minOf(5, values.size)
        if (n == 0) {
            appendLine("(empty)")
            return
        }
        for (i in 0 until n) {
            appendLine("[$i] ${values[i]}")
        }
    }

    private fun appendLine(line: String) {
        outputText = outputText + "\n" + line
        Log.i(tag, line)
    }
}
