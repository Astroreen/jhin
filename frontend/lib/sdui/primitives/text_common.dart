/// Shared text-style parsing for the text-bearing primitives (`text`,
/// `rich_text`, `code_block`): the `style` typography token of §2.6, the
/// TextStyle map of a `rich_text` span, and the `strutStyle` /
/// `textWidthBasis` / `locale` companions of the `text` primitive. Every
/// parser degrades to null on unknown input (§2.4 — the client never
/// crashes on server content).
library;

import 'package:flutter/material.dart';

import '../../design/tokens.dart';
import '../ui_registry.dart' show parseColor;

/// The `style` typography token (§2.1/§2.6): `h1`/`h2`/`h3`/`body`/
/// `small`/`caption`/`mono` looked up in the `typography` token lattice
/// (`caption` maps to `small`). An unknown token degrades to null — the
/// caller applies its default.
TextStyle? typographyStyle(String? token, JhinTokens tokens) {
  switch (token) {
    case 'h1':
      return tokens.typography.h1;
    case 'h2':
      return tokens.typography.h2;
    case 'h3':
      return tokens.typography.h3;
    case 'small':
    case 'caption':
      return tokens.typography.small;
    case 'mono':
      return tokens.typography.mono;
    case 'body':
      return tokens.typography.body;
  }
  return null;
}

/// A TextStyle map (`rich_text` span `style`, §2.6): the universal Text
/// group keys (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`,
/// `letterSpacing`, `wordSpacing`, `height`, `textDecoration`) plus the
/// legacy `color`. Unknown keys and malformed values are ignored (§2.4).
TextStyle? parseTextStyleMap(Object? value) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final fontFamily = map['fontFamily'] is String ? map['fontFamily'] as String : null;
  final fontSize = map['fontSize'] is num ? (map['fontSize'] as num).toDouble() : null;
  final fontWeight = _fontWeight(map['fontWeight']);
  final fontStyle = _fontStyle(map['fontStyle']);
  final letterSpacing = map['letterSpacing'] is num ? (map['letterSpacing'] as num).toDouble() : null;
  final wordSpacing = map['wordSpacing'] is num ? (map['wordSpacing'] as num).toDouble() : null;
  final height = map['height'] is num ? (map['height'] as num).toDouble() : null;
  final decoration = _textDecoration(map['textDecoration']);
  final color = parseColor(map['color']);
  if (fontFamily == null &&
      fontSize == null &&
      fontWeight == null &&
      fontStyle == null &&
      letterSpacing == null &&
      wordSpacing == null &&
      height == null &&
      decoration == null &&
      color == null) {
    return null;
  }
  return TextStyle(
    fontFamily: fontFamily,
    fontSize: fontSize,
    fontWeight: fontWeight,
    fontStyle: fontStyle,
    letterSpacing: letterSpacing,
    wordSpacing: wordSpacing,
    height: height,
    decoration: decoration,
    color: color,
  );
}

/// The `strutStyle` object of §2.6: `{size?, height?, leading?}`.
/// Malformed values degrade to null (no strut).
StrutStyle? parseStrutStyle(Object? value) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final size = map['size'] is num ? (map['size'] as num).toDouble() : null;
  final height = map['height'] is num ? (map['height'] as num).toDouble() : null;
  final leading = map['leading'] is num ? (map['leading'] as num).toDouble() : null;
  if (size == null && height == null && leading == null) return null;
  return StrutStyle(fontSize: size, height: height, leading: leading);
}

/// The `textWidthBasis` literal of §2.6; unknown degrades to null.
/// Flutter has no `character` basis, so that documented literal degrades to
/// the prop's default (`parent`, §2.4).
TextWidthBasis? parseTextWidthBasis(String? value) {
  switch (value) {
    case 'parent':
    case 'character':
      return TextWidthBasis.parent;
    case 'longestLine':
      return TextWidthBasis.longestLine;
  }
  return null;
}

/// A BCP-47 `locale` tag of §2.6 (`en`, `en-US`, `zh-Hans-CN`); malformed
/// input degrades to null.
Locale? parseLocale(String? value) {
  if (value == null || value.isEmpty) return null;
  final parts = value.split(RegExp(r'[-_]'));
  final language = parts.first;
  if (language.isEmpty) return null;
  if (parts.length == 1) return Locale(language);
  if (parts.length == 2) return Locale.fromSubtags(languageCode: language, countryCode: parts[1]);
  return Locale.fromSubtags(
      languageCode: language, scriptCode: parts[1], countryCode: parts[2]);
}

FontWeight? _fontWeight(Object? value) {
  if (value is! num || value < 100 || value > 900) return null;
  final index = ((value - 100) / 100).round().clamp(0, FontWeight.values.length - 1);
  return FontWeight.values[index];
}

FontStyle? _fontStyle(Object? value) {
  switch (value) {
    case 'normal':
      return FontStyle.normal;
    case 'italic':
      return FontStyle.italic;
  }
  return null;
}

TextDecoration? _textDecoration(Object? value) {
  switch (value) {
    case 'none':
      return TextDecoration.none;
    case 'underline':
      return TextDecoration.underline;
    case 'overline':
      return TextDecoration.overline;
    case 'lineThrough':
      return TextDecoration.lineThrough;
  }
  return null;
}
