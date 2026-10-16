package com.ninjalama.agentdeck;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Saves a file from the AgentDeck server into the public Downloads folder via
 * Android's DownloadManager (web/src/util/download.ts). The system shows the
 * progress/"download complete" notification; the call resolves once the
 * download has finished.
 *
 * Completion is read from the download's row, not from the broadcast alone:
 * some devices send ACTION_DOWNLOAD_COMPLETE while the download is still
 * pending or running (it then read as "failed, code 0"), others drop it. A
 * broadcast for an unfinished download is ignored, and a poll catches
 * downloads whose broadcast never came.
 *
 * Error codes: UNAVAILABLE / no code → not started (caller falls back to the
 * system browser), DOWNLOAD_FAILED → started but did not complete.
 */
@CapacitorPlugin(name = "FileDownload")
public class FileDownloadPlugin extends Plugin {

    private static final long POLL_MS = 2000;

    private final Map<Long, PluginCall> pending = new ConcurrentHashMap<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private BroadcastReceiver receiver;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            for (Long id : pending.keySet()) settle(id);
            if (!pending.isEmpty()) handler.postDelayed(this, POLL_MS);
        }
    };

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (pending.containsKey(id)) settle(id);
            }
        };
        // Exported: the broadcast is sent by the system's download provider.
        ContextCompat.registerReceiver(
            getContext(),
            receiver,
            new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacks(poll);
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // never registered
            }
            receiver = null;
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        // Below Android 10 the public Downloads folder needs a storage permission.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.unavailable("In-app downloads need Android 10 or newer.");
            return;
        }
        String url = call.getString("url");
        String fileName = call.getString("fileName");
        if (url == null || url.isEmpty() || fileName == null || fileName.isEmpty()) {
            call.reject("url and fileName are required.");
            return;
        }
        String safeName = fileName.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(safeName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName);
            // Without it, "open" on the finished download depends on the server's header.
            String mimeType = call.getString("mimeType");
            if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext();) {
                    String key = it.next();
                    String value = headers.getString(key);
                    if (value != null) request.addRequestHeader(key, value);
                }
            }
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            long id = manager.enqueue(request);
            pending.put(id, call);
            handler.removeCallbacks(poll);
            handler.postDelayed(poll, POLL_MS);
        } catch (Exception e) {
            call.reject("Could not start the download: " + e.getMessage());
        }
    }

    /** Settles the call for download `id` once its row shows a final state; no-op while it is still running. */
    private void settle(long id) {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        Integer status = null;
        int reason = 0;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            }
        } catch (Exception ignored) {
            return; // try again on the next poll
        }
        if (status != null && status != DownloadManager.STATUS_SUCCESSFUL && status != DownloadManager.STATUS_FAILED) {
            return; // pending, running or paused (waiting for network / retry)
        }
        PluginCall call = pending.remove(id);
        if (call == null) return;
        if (status == null) {
            // The row is gone: the download was cancelled (notification swiped, removed in Downloads).
            call.reject("Download was cancelled", "DOWNLOAD_FAILED");
        } else if (status == DownloadManager.STATUS_SUCCESSFUL) {
            call.resolve();
        } else {
            call.reject(failureMessage(reason), "DOWNLOAD_FAILED");
        }
    }

    /** `reason` is the HTTP status for server errors, else a DownloadManager.ERROR_* code. */
    private static String failureMessage(int reason) {
        if (reason >= 400 && reason < 600) return "Download failed (HTTP " + reason + ")";
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "Download failed: not enough storage space";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
                return "Download failed: the file already exists in Downloads";
            case DownloadManager.ERROR_FILE_ERROR:
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                return "Download failed: could not write to Downloads";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "Download failed: the connection dropped";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "Download failed: unexpected server response";
            default:
                return "Download failed (code " + reason + ")";
        }
    }
}
