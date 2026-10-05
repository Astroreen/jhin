import 'store_migration.dart';
import 'v1_to_v2.dart';
import 'v2_to_v3.dart';
import 'v3_to_v4.dart';

/// The migration chain registry (docs/updates.md §2).
///
/// `current` is the schema version this build reads and writes. Order
/// matters: the runner applies `from→to` steps in list order. Never edit an
/// already-shipped step — a fix is a new step on top (§6).
final class StoreMigrations {
  StoreMigrations._();

  /// The schema version of the persisted-data format this build writes.
  static const int current = 4;

  /// The upgrade chain, in application order.
  static final List<StoreMigration> steps = [V1ToV2(), V2ToV3(), V3ToV4()];
}
