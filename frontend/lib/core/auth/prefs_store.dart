import 'package:shared_preferences/shared_preferences.dart';

import 'string_store.dart';

/// [StringStore] over `shared_preferences` — the non-secret backend
/// (server profiles, active profile id).
class PrefsStringStore implements StringStore {
  PrefsStringStore({Future<SharedPreferences> Function()? loader})
      : _loader = loader ?? SharedPreferences.getInstance;

  final Future<SharedPreferences> Function() _loader;

  @override
  Future<String?> read(String key) async => (await _loader()).getString(key);

  @override
  Future<void> write(String key, String value) async {
    final prefs = await _loader();
    await prefs.setString(key, value);
  }

  @override
  Future<void> delete(String key) async {
    final prefs = await _loader();
    await prefs.remove(key);
  }
}