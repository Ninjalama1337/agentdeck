package com.ninjalama.agentdeck;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * AgentDeck as a share target: text, links, images and files another app
 * shares ("Share → AgentDeck", see the intent filters added by
 * scripts/patch-android.mjs) reach the web app.
 *
 * - `shared` event: the text and, per file, its name, type and size.
 * - read({ index }): the bytes of one shared file as base64. The web app asks
 *   for them when the user picked the chat they go to.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    /** A marker on an intent that was already handed to the web app. */
    private static final String EXTRA_DONE = "agentdeck_share_done";
    private static final int MAX_FILES = 10;
    private static final long MAX_BYTES = 25L * 1024 * 1024;

    /** Files of the latest share; read() looks them up by position. */
    private final List<Uri> files = new ArrayList<>();

    @Override
    public void load() {
        if (getActivity() != null) {
            deliver(getActivity().getIntent());
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliver(intent);
    }

    private void deliver(Intent intent) {
        if (intent == null || intent.getBooleanExtra(EXTRA_DONE, false)) return;
        String action = intent.getAction();
        boolean one = Intent.ACTION_SEND.equals(action);
        boolean many = Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (!one && !many) return;
        // The activity keeps its intent: without the marker a rotation would share again.
        intent.putExtra(EXTRA_DONE, true);

        List<Uri> uris = new ArrayList<>();
        try {
            if (one) {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) uris.add(uri);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) {
                    for (Uri uri : list) {
                        if (uri != null && uris.size() < MAX_FILES) uris.add(uri);
                    }
                }
            }
        } catch (Exception e) {
            // A malformed extra: share the text alone.
        }

        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        CharSequence body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        StringBuilder text = new StringBuilder();
        if (subject != null && !subject.trim().isEmpty() && (body == null || !body.toString().contains(subject.trim()))) {
            text.append(subject.trim());
        }
        if (body != null && !body.toString().trim().isEmpty()) {
            if (text.length() > 0) text.append("\n");
            text.append(body.toString().trim());
        }
        if (uris.isEmpty() && text.length() == 0) return;

        synchronized (files) {
            files.clear();
            files.addAll(uris);
        }
        JSArray list = new JSArray();
        String fallbackType = intent.getType();
        for (int i = 0; i < uris.size(); i++) {
            list.put(describe(uris.get(i), i, fallbackType));
        }
        JSObject event = new JSObject();
        event.put("text", text.toString());
        event.put("files", list);
        // Retained: on a cold start the web app registers its listener later.
        notifyListeners("shared", event, true);
    }

    private JSObject describe(Uri uri, int index, String fallbackType) {
        String name = null;
        long size = -1;
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameColumn >= 0) name = cursor.getString(nameColumn);
                if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
            }
        } catch (Exception e) {
            // Not every provider answers a query; the stream can still be read.
        }
        String type = null;
        try {
            type = getContext().getContentResolver().getType(uri);
        } catch (Exception e) {
            // unknown type
        }
        if (type == null || type.isEmpty()) {
            type = fallbackType != null && !fallbackType.contains("*") ? fallbackType : "application/octet-stream";
        }
        if (name == null || name.trim().isEmpty()) {
            String last = uri.getLastPathSegment();
            name = last != null && !last.trim().isEmpty() ? last : "shared-" + (index + 1);
        }
        JSObject file = new JSObject();
        file.put("index", index);
        file.put("name", name);
        file.put("mime", type);
        file.put("size", size);
        return file;
    }

    @PluginMethod
    public void read(PluginCall call) {
        Integer index = call.getInt("index");
        Uri uri = null;
        synchronized (files) {
            if (index != null && index >= 0 && index < files.size()) uri = files.get(index);
        }
        if (uri == null) {
            call.reject("That file is no longer shared");
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) {
                call.reject("Could not open the shared file");
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buffer)) > 0) {
                total += n;
                if (total > MAX_BYTES) {
                    call.reject("The file is larger than 25 MB");
                    return;
                }
                out.write(buffer, 0, n);
            }
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the shared file", e);
        }
    }
}
