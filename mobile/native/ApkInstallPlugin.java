package com.ninjalama.agentdeck;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * App self-update (web/src/util/download.ts): downloads the server's latest
 * APK into the app's cache and hands it to Android's package installer, which
 * asks "Update this app?" — and, the first time, for the permission to
 * install from this source (REQUEST_INSTALL_PACKAGES, see patch-android.mjs).
 *
 * Emits `progress` events ({ fraction: 0..1 }) while downloading; the call
 * resolves once the installer is on screen.
 *
 * Error codes: UNAVAILABLE → not possible here (caller falls back to a plain
 * download), DOWNLOAD_FAILED → the file did not arrive or is not an APK,
 * INSTALL_FAILED → the installer could not be opened.
 */
@CapacitorPlugin(name = "ApkInstall")
public class ApkInstallPlugin extends Plugin {

    private static final String APK_MIME = "application/vnd.android.package-archive";
    // One fixed file: every update replaces the last, nothing piles up.
    private static final String FILE_NAME = "agentdeck-update.apk";

    private volatile boolean running = false;

    /** The repo UpdateCheckWorker reads releases from (a fork builds with its own). */
    @PluginMethod
    public void configureUpdates(PluginCall call) {
        String repo = call.getString("repo");
        if (repo != null && repo.matches("^[\\w.-]+/[\\w.-]+$")) {
            NotifyActionsPlugin.prefs(getContext()).edit().putString(UpdateCheckWorker.KEY_REPO, repo).apply();
        }
        call.resolve();
    }

    /**
     * The installed versionName. The web bundle's own constant can be stale:
     * right after an update the service worker still serves the old bundle.
     */
    @PluginMethod
    public void version(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("version", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception e) {
            result.put("version", (String) null);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void install(final PluginCall call) {
        // Content URIs for the installer need Android 7.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            call.unavailable("In-app updates need Android 7 or newer.");
            return;
        }
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required.");
            return;
        }
        if (running) {
            call.reject("An update is already downloading.", "DOWNLOAD_FAILED");
            return;
        }
        running = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File apk = download(url);
                    open(apk);
                    call.resolve();
                } catch (InstallException e) {
                    call.reject(e.getMessage(), e.code);
                } catch (Exception e) {
                    call.reject("Download failed: " + e.getMessage(), "DOWNLOAD_FAILED");
                } finally {
                    running = false;
                }
            }
        }, "agentdeck-apk-install").start();
    }

    private File download(String url) throws Exception {
        Context context = getContext();
        File dir = new File(context.getCacheDir(), "update");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new InstallException("Could not create the download folder.", "DOWNLOAD_FAILED");
        }
        File target = new File(dir, FILE_NAME);

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new InstallException("Download failed (HTTP " + status + ")", "DOWNLOAD_FAILED");
            }
            long total = connection.getContentLength();
            long done = 0;
            int lastPercent = -1;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    done += read;
                    if (total > 0) {
                        int percent = (int) (done * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject event = new JSObject();
                            event.put("fraction", percent / 100.0);
                            notifyListeners("progress", event);
                        }
                    }
                }
            }
        } finally {
            connection.disconnect();
        }

        // An error page or a cut-off download must not reach the installer.
        if (context.getPackageManager().getPackageArchiveInfo(target.getAbsolutePath(), 0) == null) {
            throw new InstallException("The downloaded file is not a valid APK.", "DOWNLOAD_FAILED");
        }
        return target;
    }

    private void open(File apk) throws InstallException {
        try {
            Context context = getContext();
            // FileProvider of the Capacitor template; its cache-path covers the cache dir.
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            throw new InstallException("Could not open the installer: " + e.getMessage(), "INSTALL_FAILED");
        }
    }

    private static class InstallException extends Exception {
        final String code;

        InstallException(String message, String code) {
            super(message);
            this.code = code;
        }
    }
}
