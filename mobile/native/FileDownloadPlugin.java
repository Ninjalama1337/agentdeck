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
 * Error codes: UNAVAILABLE / no code → not started (caller falls back to the
 * system browser), DOWNLOAD_FAILED → started but did not complete.
 */
@CapacitorPlugin(name = "FileDownload")
public class FileDownloadPlugin extends Plugin {

    private final Map<Long, PluginCall> pending = new ConcurrentHashMap<>();
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                PluginCall call = pending.remove(id);
                if (call != null) finish(call, id);
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
        } catch (Exception e) {
            call.reject("Could not start the download: " + e.getMessage());
        }
    }

    private void finish(PluginCall call, long id) {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        int status = DownloadManager.STATUS_FAILED;
        int reason = 0;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            }
        } catch (Exception ignored) {
            // treated as failed
        }
        if (status == DownloadManager.STATUS_SUCCESSFUL) {
            call.resolve();
        } else {
            // `reason` is the HTTP status for server errors, else a DownloadManager.ERROR_* code.
            call.reject("Download failed (code " + reason + ")", "DOWNLOAD_FAILED");
        }
    }
}
