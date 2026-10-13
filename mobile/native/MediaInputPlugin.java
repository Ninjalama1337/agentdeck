package com.ninjalama.agentdeck;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Images and files that reach the app while it is open: what the keyboard
 * inserts (a screenshot or picture from Gboard's clipboard row, a GIF, a
 * sticker — see AgentDeckWebView) and what the system clipboard holds.
 *
 * - `media` event: the files the keyboard just inserted, per file its id,
 *   name, type and size.
 * - clipboard(): the clipboard's text and files, described the same way.
 * - read({ id }): the bytes of one such file as base64.
 *
 * The access a keyboard or the clipboard grants ends quickly, so every file
 * is copied into the app's cache the moment it arrives.
 */
@CapacitorPlugin(name = "MediaInput")
public class MediaInputPlugin extends Plugin {

    private static final long MAX_BYTES = 25L * 1024 * 1024;
    /** Copies kept; older ones are deleted. */
    private static final int KEEP = 20;

    private static volatile MediaInputPlugin instance;

    private final LinkedHashMap<Integer, File> copies = new LinkedHashMap<>();
    private int nextId = 1;

    @Override
    public void load() {
        // Copies of an earlier run are of no use: their ids are gone.
        File[] old = dir().listFiles();
        if (old != null) {
            for (File file : old) file.delete();
        }
        instance = this;
    }

    /** The keyboard inserted `uri`. False when it could not be taken over (the keyboard then says so). */
    static boolean fromKeyboard(Uri uri, String mime) {
        MediaInputPlugin plugin = instance;
        if (plugin == null || uri == null) return false;
        JSObject file = plugin.keep(uri, mime);
        if (file == null) return false;
        JSArray list = new JSArray();
        list.put(file);
        JSObject event = new JSObject();
        event.put("files", list);
        plugin.notifyListeners("media", event);
        return true;
    }

    @PluginMethod
    public void clipboard(PluginCall call) {
        JSArray list = new JSArray();
        String text = "";
        try {
            ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = manager != null ? manager.getPrimaryClip() : null;
            if (clip != null) {
                String type = clip.getDescription() != null && clip.getDescription().getMimeTypeCount() > 0
                    ? clip.getDescription().getMimeType(0)
                    : null;
                for (int i = 0; i < clip.getItemCount(); i++) {
                    ClipData.Item item = clip.getItemAt(i);
                    if (item == null) continue;
                    if (item.getUri() != null) {
                        JSObject file = keep(item.getUri(), type);
                        if (file != null) list.put(file);
                    } else if (text.isEmpty() && item.getText() != null) {
                        text = item.getText().toString();
                    }
                }
            }
        } catch (Exception e) {
            call.reject("The clipboard could not be read", e);
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text);
        result.put("files", list);
        call.resolve(result);
    }

    @PluginMethod
    public void read(PluginCall call) {
        Integer id = call.getInt("id");
        File file;
        synchronized (copies) {
            file = id != null ? copies.get(id) : null;
        }
        if (file == null || !file.isFile()) {
            call.reject("That file is no longer available");
            return;
        }
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the file", e);
        }
    }

    private File dir() {
        File dir = new File(getContext().getCacheDir(), "media-input");
        dir.mkdirs();
        return dir;
    }

    /** Copies `uri` into the cache and describes it; null when it cannot be read or is too large. */
    private JSObject keep(Uri uri, String fallbackType) {
        String name = null;
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameColumn >= 0) name = cursor.getString(nameColumn);
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
        if (type == null || type.isEmpty() || type.contains("*")) {
            type = fallbackType != null && !fallbackType.contains("*") ? fallbackType : "application/octet-stream";
        }

        int id;
        File copy;
        synchronized (copies) {
            id = nextId++;
            copy = new File(dir(), "media-" + id);
        }
        long total = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(copy)) {
            if (in == null) {
                copy.delete();
                return null;
            }
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) {
                total += n;
                if (total > MAX_BYTES) break;
                out.write(buffer, 0, n);
            }
        } catch (Exception e) {
            copy.delete();
            return null;
        }
        if (total > MAX_BYTES) {
            copy.delete();
            return null;
        }

        synchronized (copies) {
            copies.put(id, copy);
            Iterator<Map.Entry<Integer, File>> oldest = copies.entrySet().iterator();
            while (copies.size() > KEEP && oldest.hasNext()) {
                oldest.next().getValue().delete();
                oldest.remove();
            }
        }
        if (name == null || name.trim().isEmpty()) name = "image-" + id;
        JSObject file = new JSObject();
        file.put("id", id);
        file.put("name", name);
        file.put("mime", type);
        file.put("size", total);
        return file;
    }
}
