import 'package:flutter/material.dart';

/// The ContextChip kind accents (T103): the upstream restrained colour
/// identity of each context pill kind — one lightness shared by every
/// accent so no kind reads heavier than another, only the hue carries the
/// identity (`components/ContextChip.tsx:30-48`, commit 37de6cb). The
/// values are the upstream `oklch(0.62 …)` literals resolved to sRGB hex
/// through the shared `Oklch` port (the ui-default JVM suite verifies the
/// constants against `Oklch.toRgb(Oklch.mapToSrgbGamut(...))`).
///
/// Design-layer data, not theme tokens: the accents are content identities
/// (like the palette seeds), stable across every theme.
const Map<String, Color> kChipKindAccents = {
  'image': Color(0xFFd55665),
  'video': Color(0xFFd06217),
  'file': Color(0xFF0090cd),
  'mention': Color(0xFF0096af),
  'terminal': Color(0xFF009f6e),
  'element': Color(0xFFb87501),
  'review-comment': Color(0xFF8a70dd),
  'pull-request': Color(0xFF7079e4),
  'pr-open': Color(0xFF009f6e),
  'pr-draft': Color(0xFF7f8793),
  'pr-merged': Color(0xFF8a70dd),
  'pr-closed': Color(0xFFd55665),
  'skill': Color(0xFFb261be),
  'thread': Color(0xFF009a94),
  'citation': Color(0xFF4684e5),
};
