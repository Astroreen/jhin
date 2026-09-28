/// SDUI-рендерер примитивов Jhin (T30).
///
/// Служебный контракт «server-driven UI»: backend/плагин шлёт JSON-описание
/// интерфейса, Flutter рендерит его через реестр примитивов [UiRegistry].
/// Неизвестный `type` → карточка-заглушка; любой сбой парсинга полей →
/// мягкий деград (пусто/заглушка), никогда — exception наверх.
///
/// Вход: `{"type": "<primitive>", ...}`; рекурсивные списки узлов — поле
/// `children` (или `items` у `list`); дочерний узел — такой же JSON-объект
/// либо строка (эквивалент `{"type":"text","text":"..."}`).
///
/// # JSON-схема примитивов
///
/// ## container
/// ```json
/// {"type": "container", "children": [UiNode...],
///  "direction": "row|column",   // default "column"
///  "padding": 8, "gap": 8}      // опционально, logical px
/// ```
///
/// ## card
/// ```json
/// {"type": "card", "title": "Заголовок?", "children": [UiNode...]}
/// ```
///
/// ## text
/// ```json
/// {"type": "text", "text": "привет",
///  "style": "h1|h2|body|caption|mono",  // опционально, default "body"
///  "bold": true,                         // опционально
///  "color": "#FF0000"}                   // hex: #RRGGBB | #AARRGGBB | 0xFFRRGGBB | int
/// ```
///
/// ## button
/// ```json
/// {"type": "button", "label": "OK", "action": "save",
///  "payload": {"id": 1},                // опционально, JSON-объект
///  "style": "primary|secondary|danger"} // опционально, default "secondary"
/// ```
/// tap → `ctx.onAction(action, payload)`; без `action` — disabled.
///
/// ## dropdown
/// ```json
/// {"type": "dropdown", "items": [{"label": "A", "value": "a"}],
///  "value": "a",                        // опционально, начальный выбор
///  "action": "pick"}
/// ```
/// выбор → `ctx.onAction(action, {"value": <оригинальное value>})`.
///
/// ## list
/// ```json
/// {"type": "list", "items": [UiNode | "строка", ...]}
/// ```
/// Прокручиваемый (высота до ~300px).
///
/// ## drawer
/// ```json
/// {"type": "drawer", "title": "Панель?", "children": [UiNode...]}
/// ```
/// Компактная боковая панель: styled-контейнер с иконкой и заголовком.
///
/// ## form
/// ```json
/// {"type": "form",
///  "fields": [
///    {"kind": "textfield", "name": "f", "label": "Имя", "value": "v", "multiline": false},
///    {"kind": "checkbox",  "name": "c", "label": "Галка", "value": true},
///    {"kind": "switch",    "name": "s", "label": "Тумблер", "value": false},
///    {"kind": "slider",    "name": "r", "label": "Уровень", "min": 0, "max": 100, "value": 50}
///  ],
///  "submit": {"label": "Отправить", "action": "apply"}}
/// ```
/// submit → `ctx.onAction(action, {name: значение каждого поля})`;
/// значения: textfield → String, checkbox/switch → bool, slider → double.
/// Неизвестные/кривые поля пропускаются.
///
/// ## chart_line
/// ```json
/// {"type": "chart_line",
///  "series": [{"name": "S", "color": "#FF0000", "points": [{"x": 0, "y": 1}]}]}
/// ```
///
/// ## chart_bar
/// ```json
/// {"type": "chart_bar", "items": [{"label": "Q1", "value": 3}]}
/// {"type": "chart_bar", "series": [{"name": "S", "values": [{"label": "Q1", "value": 3}]}]}
/// ```
/// `items` — одна серия; `series` — сгруппированные серии по меткам.
///
/// ## chart_pie
/// ```json
/// {"type": "chart_pie", "items": [{"label": "A", "value": 3, "color": "#FF0000"}]}
/// ```
///
/// ## figure
/// ```json
/// {"type": "figure", "shape": "rectangle|circle|triangle",
///  "color": "#FF0000", "width": 100, "height": 80}
/// ```
///
/// ## table
/// ```json
/// {"type": "table", "columns": [{"label": "A"}], "rows": [["a", 1]]}
/// ```
///
/// ## markdown
/// ```json
/// {"type": "markdown", "text": "# Заголовок"}
/// ```
///
/// ## unknown type
/// Любое иное `type` → карточка «Unsupported UI element: &lt;type&gt;» с иконкой.
///
/// # UiContext
/// `sessionId` + `onAction(action, payload)` — кнопки/формы/дропдауны зовут
/// колбэк; реализация на экранах отправляет `POST /sessions/{id}/ui-action`.
library;

import 'package:flutter/widgets.dart';

import '../primitives/button_primitive.dart';
import '../primitives/card_primitive.dart';
import '../primitives/chart_bar_primitive.dart';
import '../primitives/chart_line_primitive.dart';
import '../primitives/chart_pie_primitive.dart';
import '../primitives/container_primitive.dart';
import '../primitives/drawer_primitive.dart';
import '../primitives/dropdown_primitive.dart';
import '../primitives/figure_primitive.dart';
import '../primitives/form_primitive.dart';
import '../primitives/list_primitive.dart';
import '../primitives/markdown_primitive.dart';
import '../primitives/table_primitive.dart';
import '../primitives/text_primitive.dart';
import '../ui_context.dart';
import '../ui_registry.dart';

/// Рендерит SDUI-узел [json] через реестр из контекста (или default).
///
/// Рекурсия через `children`/`items`; любой сбой — мягкий деград.
/// См. dartdoc-библиотеку файла — полная JSON-схема примитивов.
Widget buildUi(Map<String, dynamic> json, UiContext ctx) {
  final registry = ctx.registry ?? defaultUiRegistry;
  return registry.build(json, ctx);
}

/// Стандартный реестр всех примитивов (14 типов + заглушка unknown).
final UiRegistry defaultUiRegistry = _createDefaultRegistry();

UiRegistry _createDefaultRegistry() {
  return UiRegistry()
    ..register('container', buildContainer)
    ..register('card', buildCard)
    ..register('text', buildText)
    ..register('button', buildButton)
    ..register('dropdown', buildDropdown)
    ..register('list', buildList)
    ..register('drawer', buildDrawer)
    ..register('form', buildForm)
    ..register('chart_line', buildChartLine)
    ..register('chart_bar', buildChartBar)
    ..register('chart_pie', buildChartPie)
    ..register('figure', buildFigure)
    ..register('table', buildTable)
    ..register('markdown', buildMarkdown);
}
