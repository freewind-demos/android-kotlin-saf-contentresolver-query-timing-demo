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
 * SAF + ContentResolver.query 耗时对比 Demo。
 *
 * 与 DocumentFile.listFiles Demo 同结构四步：
 * query(list documentId) → build uris → query names → query sizes。
 * 结果进数组；界面只报动作、条数、ms。
 */
class MainActivity : ComponentActivity() {

    // Logcat 过滤用
    private val tag = "SafQueryTiming"

    // 用户选中的目录树 Uri
    private var treeUri by mutableStateOf<Uri?>(null)

    // 耗时日志
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
                            text = "四步：query documentId → fetch uris → query names → query sizes。" +
                                "结果进数组；只报条数与 ms。",
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
     * 四步（均经 ContentResolver / DocumentsContract，不用 DocumentFile）：
     * 1) query 子文档 COLUMN_DOCUMENT_ID → documentIds 数组（≈ listFiles）
     * 2) 用 documentId 拼 Uri → uris 数组
     * 3) 再 query COLUMN_DISPLAY_NAME → names 数组
     * 4) 再 query COLUMN_SIZE → sizes 数组
     */
    private suspend fun runTimedQueryScan(treeUri: Uri) {
        // 子目录查询 Uri：tree + documentId
        val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)

        // —— 1) query list（只要 documentId）——
        val listStarted = SystemClock.elapsedRealtime()
        val documentIds = withContext(Dispatchers.IO) {
            queryColumnStrings(
                childrenUri,
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            )
        }
        val listMs = SystemClock.elapsedRealtime() - listStarted
        appendLine("query list (documentId): ${documentIds.size} items, ${listMs} ms")

        // —— 2) fetch all uris（本地拼 Uri，不再 query）——
        val urisStarted = SystemClock.elapsedRealtime()
        val uris = withContext(Dispatchers.IO) {
            ArrayList<Uri>(documentIds.size).also { out ->
                for (docId in documentIds) {
                    out.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, docId))
                }
            }
        }
        val urisMs = SystemClock.elapsedRealtime() - urisStarted
        appendLine("fetch all uris: ${uris.size} items, ${urisMs} ms")

        // —— 3) query names ——
        val namesStarted = SystemClock.elapsedRealtime()
        val names = withContext(Dispatchers.IO) {
            queryColumnStrings(
                childrenUri,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            )
        }
        val namesMs = SystemClock.elapsedRealtime() - namesStarted
        appendLine("query all names: ${names.size} items, ${namesMs} ms")

        // —— 4) query sizes ——
        val sizesStarted = SystemClock.elapsedRealtime()
        val sizes = withContext(Dispatchers.IO) {
            queryColumnLongs(
                childrenUri,
                DocumentsContract.Document.COLUMN_SIZE,
            )
        }
        val sizesMs = SystemClock.elapsedRealtime() - sizesStarted
        appendLine("query all sizes: ${sizes.size} items, ${sizesMs} ms")

        // 引用数组，防判定无用；不打印细节
        Log.d(
            tag,
            "kept arrays: ids=${documentIds.size}, uris=${uris.size}, names=${names.size}, sizes=${sizes.size}",
        )
    }

    /**
     * 对 childrenUri 做一次 query，把指定字符串列全部读进 ArrayList。
     * cursor 为 null → 直接报错（禁 silent fallback）。
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

    /** 同 queryColumnStrings，读 Long 列（SIZE）。缺省/null → 仍占一条，值为 null。 */
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

    private fun appendLine(line: String) {
        outputText = outputText + "\n" + line
        Log.i(tag, line)
    }
}
