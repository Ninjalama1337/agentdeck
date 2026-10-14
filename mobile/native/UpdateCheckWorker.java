package com.ninjalama.agentdeck;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Background check for a newer APK, also while the app is closed: every few
 * hours WorkManager reads the latest GitHub release; a newer one than the
 * installed app gets one notification per version ("AgentDeck vX.Y.Z is
 * available"). A tap opens the app with `apk-update:<version>`, which starts
 * the in-app download and Android's installer (ApkInstallPlugin).
 *
 * The notification has its own channel ("App updates"), so Android's settings
 * can switch it off without touching the agent alerts.
 */
public class UpdateCheckWorker extends Worker {

    static final String CHANNEL_ID = "agentdeck-updates";
    static final String DEFAULT_REPO = "Ninjalama1337/agentdeck";
    static final String APK_ASSET = "app-debug.apk";
    static final String KEY_REPO = "update_repo";
    static final String KEY_NOTIFIED = "update_notified";
    private static final String WORK_NAME = "agentdeck-update-check";
    private static final String NOTIFICATION_TAG = "agentdeck-update";

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Idempotent: a check already scheduled keeps its rhythm. The first run happens right away. */
    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(UpdateCheckWorker.class, 6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = NotifyActionsPlugin.prefs(context);
        try {
            String current = installedVersion(context);
            String latest = latestVersion(prefs.getString(KEY_REPO, DEFAULT_REPO));
            if (current == null || latest == null || compare(latest, current) <= 0) return Result.success();
            // In front, the app shows its own update banner.
            if (MainActivity.visible) return Result.success();
            if (latest.equals(prefs.getString(KEY_NOTIFIED, null))) return Result.success();
            if (show(context, latest)) prefs.edit().putString(KEY_NOTIFIED, latest).apply();
        } catch (Exception e) {
            // Offline, rate limit, GitHub hiccup: the next period tries again.
        }
        return Result.success();
    }

    private static String installedVersion(Context context) throws Exception {
        String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        // A local build without a release version has nothing to compare.
        return name != null && name.matches("^\\d+\\.\\d+\\.\\d+.*") ? name : null;
    }

    /** Version of the latest release that carries the APK, or null. */
    private static String latestVersion(String repo) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/repos/" + repo + "/releases/latest").openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "AgentDeck-Android");
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            JSONObject release;
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                release = new JSONObject(out.toString("UTF-8"));
            }
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null;
            JSONArray assets = release.optJSONArray("assets");
            boolean hasApk = false;
            for (int i = 0; assets != null && i < assets.length(); i++) {
                if (APK_ASSET.equals(assets.getJSONObject(i).optString("name"))) hasApk = true;
            }
            String version = release.optString("tag_name", "").replaceFirst("^v", "");
            return hasApk && version.matches("^\\d+\\.\\d+\\.\\d+.*") ? version : null;
        } finally {
            connection.disconnect();
        }
    }

    /** Compares the numeric x.y.z parts. */
    static int compare(String a, String b) {
        String[] pa = a.split("[^0-9]+");
        String[] pb = b.split("[^0-9]+");
        for (int i = 0; i < 3; i++) {
            long x = i < pa.length && !pa[i].isEmpty() ? Long.parseLong(pa[i]) : 0;
            long y = i < pb.length && !pb[i].isEmpty() ? Long.parseLong(pb[i]) : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    private static boolean show(Context context, String version) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "App updates", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("A new version of the AgentDeck app is available");
            nm.createNotificationChannel(channel);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(NotifyActionsPlugin.EXTRA_OPEN, "apk-update:" + version);
        PendingIntent content = PendingIntent.getActivity(
            context,
            NOTIFICATION_TAG.hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_agentdeck)
            .setContentTitle("AgentDeck v" + version + " is available")
            .setContentText("Tap to download and install the update")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setAutoCancel(true)
            .setContentIntent(content)
            .addAction(new NotificationCompat.Action.Builder(0, "Install", content).build());
        nm.notify(NOTIFICATION_TAG, 1, builder.build());
        return true;
    }
}
