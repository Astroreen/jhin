import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';

/// T83: the token surface mirror (`tokens.dart`) and the per-theme
/// resolution (`theme.dart`). Spot checks pin the same upstream values the
/// JVM side pins in `BootstrapContractTest` — the two mirrors must not drift.
void main() {
  group('JhinTokenSurface — the §4.3 key set', () {
    test('carries every family with its exact key set', () {
      final surface = JhinTokenSurface.defaults();
      expect(JhinTokenSurface.familyNames, {
        'color', 'radius', 'text', 'font', 'space', 'layout',
        'glass', 'motion', 'shadow', 'scroll', 'z',
      });
      expect(surface.keys('radius'),
          {'base', 'sm', 'md', 'lg', 'xl', 'xl2', 'xl3'});
      expect(surface.keys('text'),
          {'xs5', 'xs4', 'xs3', 'xs2', 'xs', 'sm', 'base', 'lg', 'xl'});
      expect(surface.keys('space'), {
        'control', 'sidebarContent', 'sidebarControlGap', 'sidebarRowContent',
        'commandShell', 'commandContent', 'floatingContent', 'workspaceGutter',
      });
      expect(surface.keys('motion'),
          {'panel', 'easeDrawer', 'skeleton', 'statusPulse', 'statusPing', 'reduced'});
      expect(surface.keys('z'), {'sheet'});
    });

    test('carries the upstream values the QA pins', () {
      final surface = JhinTokenSurface.defaults();
      expect(surface.value('color', 'sidebar-row-hover'), 'var(--sidebar-row-hover)');
      expect(surface.value('radius', 'base'), '0.625rem');
      expect(surface.value('layout', 'topbarHeight'), 52);
      expect(surface.value('motion', 'easeDrawer'), 'cubic-bezier(0.32, 0.72, 0, 1)');
      expect(surface.value('motion', 'panel'), 0);
      expect(surface.value('z', 'sheet'), 46);
    });

    test('bootstrap overrides merge key-by-key, unknown keys ignored', () {
      final surface = JhinTokenSurface.fromOverrides(const {
        'motion': {'panel': 200, 'nope': 1},
        'radius': {'base': '0.75rem'},
        'nope': {'x': 1},
      });
      expect(surface.value('motion', 'panel'), 200);
      expect(surface.value('motion', 'easeDrawer'), 'cubic-bezier(0.32, 0.72, 0, 1)');
      expect(surface.value('radius', 'base'), '0.75rem');
      expect(surface.value('radius', 'sm'), 'calc(0.625rem - 4px)');
      expect(surface.value('nope', 'x'), isNull);
    });
  });

  group('JhinTheme.resolve — per active theme', () {
    test('collapses {light, dark} maps to the brightness', () {
      final theme = JhinTheme.from();
      expect(theme.resolve('glass', 'blur', brightness: Brightness.light), 12);
      expect(theme.resolve('glass', 'blur', brightness: Brightness.dark), 16);
      expect(theme.resolve('glass', 'saturation', brightness: Brightness.dark), 1.08);
      expect(theme.resolve('scroll', 'thumb', brightness: Brightness.light),
          'rgb(217 217 217)');
      expect(theme.resolve('scroll', 'thumb', brightness: Brightness.dark),
          'rgb(255 255 255 / 8%)');
      expect(
          theme.resolve('shadow', 'composer', brightness: Brightness.dark),
          '0 14px 32px -18px rgb(0 0 0 / 75%)');
    });

    test('collapses {base, sm} maps to the base step', () {
      final theme = JhinTheme.from();
      expect(theme.resolve('space', 'workspaceGutter'), '0.75rem');
    });

    test('scalar and pair values pass through', () {
      final theme = JhinTheme.from();
      expect(theme.resolve('glass', 'opacity'), '80%');
      expect(theme.resolve('text', 'xs3'),
          {'size': '0.625rem', 'lineHeight': 'calc(0.875 / 0.625)'});
      expect(theme.resolve('font', 'sizeInterface'), 16);
      expect(theme.resolve('radius', 'nope'), isNull);
    });

    test('the bootstrap panel duration reaches the resolved motion key', () {
      final theme = JhinTheme.fromBootstrap(const {
        'tokens': {
          'motion': {'panel': 200},
        },
      });
      expect(theme.resolve('motion', 'panel'), 200);
    });
  });
}
