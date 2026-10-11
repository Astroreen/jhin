/**
 * The T206 mechanical proof (mirrors the plan verbatim): a JVM probe renders
 * one representative {@link UiNode} per docs/sdui.md section 2.5 catalog name
 * through {@code HtmlRenderer.renderFragment} and pins the output as the
 * committed {@code src/test/resources/gallery/<name>.html} fixtures, and a
 * prop-completeness probe renders every (primitive, prop) pair of section 2.6
 * with and without the prop and asserts the outputs differ — the prop is
 * reflected in the emitted HTML.
 *
 * <p>Gallery contract: {@code 0} occurrences of {@code jhin-unsupported}
 * (the placeholder stays reserved for out-of-catalog types), every fixture
 * starts with {@code <} and carries {@code data-jhin-type}, and the fixture
 * count equals the catalog count. The fixtures are a byte-equal regression
 * pin: when a renderer legitimately changes, regenerate deliberately with
 * {@code ./gradlew :jhin-plugin-ui-default:test --tests '*HtmlConformanceTest*'
 * -Djhin.gallery.regen=true} (the documented regen path — never hand-edit).
 *
 * <p>Prop-completeness contract: the (primitive, prop) pair inventory is
 * parsed from the section 2.6 tables of {@code docs/sdui.md} at test time
 * (the same normative source the renderers implement — a Java-side mirror
 * table would drift; the sample <em>values</em> are Java-side, keyed by the
 * Type column). A pair whose outputs do not differ lands in
 * {@code build/unknown-props.txt} unless it is in the allowlist below; the
 * test asserts the list is empty (the QA script copies the artifact into the
 * evidence — T206 chunk 3). Props may reach the wire through any channel —
 * attribute, style, class, text content or child structure — including the
 * {@code PropReflection} backstop ({@code data-jhin-*} attributes), so the
 * allowlist is for props with no channel at all and stays empty while every
 * prop reflects.
 *
 * <p>Fixture maps are insertion-ordered ({@code Map.of} randomizes iteration
 * order per JVM run and would make the gallery byte-different every run).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class HtmlConformanceTest {

    /** The normative contract document, relative to this module. */
    private static final Path DOC = Path.of("..", "..", "docs", "sdui.md");

    /** The committed fixture directory (test resources — the regen target). */
    private static final Path GALLERY = Path.of("src", "test", "resources", "gallery");

    /** The prop-completeness artifact: pairs whose output does not differ. */
    private static final Path UNKNOWN_PROPS = Path.of("build", "unknown-props.txt");

    /** The documented regen switch: {@code -Djhin.gallery.regen=true}. */
    private static final String REGEN_PROPERTY = "jhin.gallery.regen";

    /**
     * The prop-completeness allowlist: props with no HTML channel at all.
     * Empty while every documented prop reflects (attribute, style, class,
     * text content or child structure); a dropped prop needs a per-prop
     * justification comment in its renderer and an entry here (T206 step 2).
     */
    private static final Set<String> ALLOWLIST = Set.of();

    /** The universal prop names of section 2.5 — props, not node types. */
    private static final Set<String> UNIVERSAL_NAMES =
            Set.of("glass", "demo", "statusPulse", "safeArea");

    private static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");

    // --- gallery ----------------------------------------------------------

    @Test
    void galleryFixturesPinOneRenderedNodePerCatalogName() throws IOException {
        List<String> catalog = new ArrayList<>(section25Catalog());
        assertThat(catalog).as("docs/sdui.md section 2.5 catalog").hasSize(68);

        boolean regen = Boolean.getBoolean(REGEN_PROPERTY);
        for (String name : catalog) {
            String html = HtmlRenderer.renderFragment(representative(name));
            assertThat(html).as("fixture %s starts with <", name).startsWith("<");
            assertThat(html).as("fixture %s carries data-jhin-type", name).contains("data-jhin-type=");
            assertThat(html).as("fixture %s never lands in the placeholder", name)
                    .doesNotContain("jhin-unsupported");

            Path source = GALLERY.resolve(name + ".html");
            if (regen) {
                Files.createDirectories(GALLERY);
                Files.writeString(source, html, StandardCharsets.UTF_8);
                continue;
            }
            byte[] expected = fixture(name);
            assertThat(new String(expected, StandardCharsets.UTF_8))
                    .as("committed fixture %s is byte-equal to the rendered output "
                            + "(regenerate deliberately with -D%s=true)", name, REGEN_PROPERTY)
                    .isEqualTo(html);
        }
    }

    @Test
    void galleryCoverageEqualsTheCatalogCount() throws IOException {
        org.junit.jupiter.api.Assumptions.assumeFalse(Boolean.getBoolean(REGEN_PROPERTY),
                "coverage asserts the committed fixtures; the regen run only writes them");
        List<String> catalog = new ArrayList<>(section25Catalog());
        try (var fixtures = Files.list(GALLERY)) {
            long count = fixtures.filter(path -> path.getFileName().toString().endsWith(".html")).count();
            assertThat(count).as("committed fixture count").isEqualTo(catalog.size());
            assertThat(count).as("gallery coverage").isGreaterThanOrEqualTo(64);
        }
    }

    // --- prop completeness (section 2.6) ----------------------------------

    @Test
    void everyDocumentedPropIsReflectedInTheHtml() throws IOException {
        List<Pair> pairs = section26Pairs();
        assertThat(pairs).as("the section 2.6 pair inventory parses").isNotEmpty();

        List<String> unknown = new ArrayList<>();
        for (Pair pair : pairs) {
            if (ALLOWLIST.contains(pair.primitive() + "." + pair.prop())) {
                continue;
            }
            if (!reflected(pair)) {
                unknown.add(pair.primitive() + "." + pair.prop());
            }
        }

        Files.createDirectories(UNKNOWN_PROPS.getParent());
        Files.writeString(UNKNOWN_PROPS,
                String.join("\n", unknown) + (unknown.isEmpty() ? "" : "\n"), StandardCharsets.UTF_8);

        assertThat(unknown)
                .as("section 2.6 props whose with/without renders do not differ "
                        + "(and are not allowlisted) — add the mapping or a justified allowlist entry")
                .isEmpty();
    }

    /**
     * Per-pair sample-value overrides where the generic Type-column sample
     * would not move the semantics (a value must match its context: an
     * {@code activeId} of the context items, the selected {@code value} of
     * the context segments/options).
     */
    private static final Map<String, Object> SAMPLE_OVERRIDES = Map.of(
            "nav.activeId", "b",
            "dropdown.value", "a",
            "segmented.value", "a");

    /** Whether the prop changes the rendered output of its primitive. */
    private static boolean reflected(Pair pair) {
        Map<String, Object> base = new LinkedHashMap<>(context(pair));
        base.remove(pair.prop());
        for (Object value : sampleValues(pair)) {
            Map<String, Object> with = new LinkedHashMap<>(base);
            with.put(pair.prop(), value);
            String before = HtmlRenderer.renderFragment(nodeFor(pair.primitive(), base));
            String after = HtmlRenderer.renderFragment(nodeFor(pair.primitive(), with));
            if (!before.equals(after)) {
                return true;
            }
        }
        return false;
    }

    // --- §2.6 pair inventory ----------------------------------------------

    private record Pair(String primitive, String prop, String type) {
    }

    /**
     * The (primitive, prop) pairs of the section 2.6 tables, in doc order:
     * the per-primitive rows and the item-shape rows ({@code nav} item,
     * {@code list} section, {@code rich_text} span, …). Item-shape rows are
     * keyed {@code "<primitive> <shape>"} and probed through their container.
     */
    private static List<Pair> section26Pairs() throws IOException {
        assertThat(DOC).as("docs/sdui.md exists relative to the module").exists();
        Set<String> catalog = section25Catalog();
        List<Pair> pairs = new ArrayList<>();
        boolean inSection = false;
        for (String line : Files.readAllLines(DOC, StandardCharsets.UTF_8)) {
            if (line.startsWith("### 2.6 ")) {
                inSection = true;
                continue;
            }
            if (inSection && line.startsWith("## ")) {
                break;
            }
            if (!inSection) {
                continue;
            }
            String stripped = line.strip();
            if (!stripped.startsWith("|") || stripped.startsWith("|---") || stripped.startsWith("| -")) {
                continue;
            }
            String[] cells = stripped.split("\\|", -1);
            if (cells.length < 4) {
                continue;
            }
            String owner = cells[1].strip();
            String prop = cells[2].strip();
            String type = cells[3].strip();
            Matcher ownerMatch = BACKTICK.matcher(owner);
            if (!ownerMatch.find()) {
                continue;
            }
            String primitive = ownerMatch.group(1);
            if (!catalog.contains(primitive) || UNIVERSAL_NAMES.contains(primitive)) {
                continue;
            }
            String shape = owner.substring(ownerMatch.end()).strip();
            if (!shape.isEmpty() && !Set.of("item", "section", "span", "hunk", "column").contains(shape)) {
                continue;
            }
            String key = shape.isEmpty() ? primitive : primitive + " " + shape;
            if (prop.equals("(any)")) {
                // textarea accepts the full input prop set (section 2.6).
                List<Pair> inputProps = pairs.stream()
                        .filter(input -> input.primitive().equals("input"))
                        .toList();
                pairs.addAll(inputProps.stream()
                        .map(input -> new Pair("textarea", input.prop(), input.type()))
                        .toList());
                continue;
            }
            Matcher propMatch = BACKTICK.matcher(prop);
            if (!propMatch.find()) {
                continue;
            }
            pairs.add(new Pair(key, propMatch.group(1), type));
        }
        return pairs;
    }

    /** The §2.5 catalog names: every backtick span of the bullet list. */
    private static Set<String> section25Catalog() throws IOException {
        assertThat(DOC).as("docs/sdui.md exists relative to the module").exists();
        Set<String> names = new TreeSet<>();
        boolean inSection = false;
        for (String line : Files.readAllLines(DOC, StandardCharsets.UTF_8)) {
            if (line.startsWith("### 2.5 ")) {
                inSection = true;
                continue;
            }
            if (inSection && line.startsWith("### ")) {
                break;
            }
            if (!inSection) {
                continue;
            }
            String stripped = line.strip();
            boolean bullet = stripped.startsWith("- ");
            boolean continuation = line.startsWith("  ") && !stripped.isEmpty();
            if (!bullet && !continuation) {
                continue;
            }
            Matcher span = BACKTICK.matcher(line);
            while (span.find()) {
                names.add(span.group(1));
            }
        }
        return names;
    }

    // --- probe nodes ------------------------------------------------------

    /**
     * The per-pair context props the probe's base node carries: only where a
     * prop is meaningless or invisible in isolation (a nav highlight needs
     * items, the segmented selection needs segments, the list separator needs
     * entries, the icon-button size needs its icon, the section uppercase
     * needs a label).
     */
    private static Map<String, Object> context(Pair pair) {
        Map<String, Object> props = new LinkedHashMap<>();
        switch (pair.primitive()) {
            case "segmented" -> props.put("segments", List.of(
                    entry("label", "A", "value", "a")));
            case "nav" -> props.put("items", List.of(
                    entry("id", "a", "label", "A"), entry("id", "b", "label", "B")));
            case "tabs" -> props.put("items", List.of(
                    entry("label", "A", "panel", new UiNode("text",
                            entry("text", "panel"), List.of()))));
            case "dropdown" -> props.put("items", List.of(
                    entry("label", "A", "value", "a")));
            case "slider" -> props.put("value", 5);
            case "icon_button" -> props.put("icon", "check");
            case "list section" -> props.put("label", "L");
            default -> {
            }
        }
        if (pair.primitive().equals("list") && pair.prop().equals("separator")) {
            // The separator is only visible between entries.
            props.put("items", List.of("one", "two"));
        }
        return props;
    }

    /**
     * The probe node of one pair key: the primitive itself, or the item
     * shape's container with a one-prop item inside (the pair's props are
     * the item map — including a nested {@code items} prop of the
     * {@code tree} item shape).
     */
    private static UiNode nodeFor(String key, Map<String, Object> props) {
        int space = key.indexOf(' ');
        if (space < 0) {
            return new UiNode(key, props, List.of());
        }
        String primitive = key.substring(0, space);
        String shape = key.substring(space + 1);
        String container = switch (shape) {
            case "section" -> "sections";
            case "span" -> "spans";
            case "hunk" -> "hunks";
            case "column" -> "columns";
            default -> "items";
        };
        Map<String, Object> nodeProps = new LinkedHashMap<>();
        nodeProps.put(container, List.of(new LinkedHashMap<>(props)));
        return new UiNode(primitive, nodeProps, List.of());
    }

    /**
     * Sample values per the Type column of section 2.6: one representative
     * value per shape (bools tried in both states — the state a renderer
     * reflects is not always the truthy one), every backticked enum literal
     * of the Type cell tried in turn (a literal equal to the built-in
     * default renders like the absent prop; the next literal differs), then
     * a generic scalar.
     */
    private static List<Object> sampleValues(Pair pair) {
        Object override = SAMPLE_OVERRIDES.get(pair.primitive() + "." + pair.prop());
        if (override != null) {
            return List.of(override);
        }
        String t = pair.type().toLowerCase();
        if (t.contains("bool")) {
            return List.of(true, false);
        }
        if (t.contains("action")) {
            return List.of(entry("path", "/ui/action/a", "name", "a"));
        }
        if (t.contains("{")) {
            // The inline shapes: rich_text span chip/image, input border maps.
            return List.of(entry("kind", "citation", "label", "[1]",
                    "src", "x.png", "semanticsLabel", "pic"));
        }
        if (t.contains("series array")) {
            // chart_line values are a plain number list, chart_bar values a
            // {label, value} item list — try both shapes.
            return List.of(
                    List.of(entry("label", "L", "color", "#123456", "values", List.of(3, 1))),
                    List.of(entry("label", "L", "color", "#123456", "values",
                            List.of(entry("label", "x", "value", 3),
                                    entry("label", "y", "value", 1)))));
        }
        if (t.contains("hunk array")) {
            return List.of(List.of(entry("header", "@@ -1 +1 @@",
                    "lines", List.of(entry("kind", "add", "oldNo", 1, "newNo", 1, "text", "t")))));
        }
        if (t.contains("line array")) {
            return List.of(List.of(entry("kind", "add", "oldNo", 1, "newNo", 1, "text", "t")));
        }
        if (t.contains("cell array")) {
            return List.of(List.of("a", "b"));
        }
        if (t.contains("string array")) {
            return List.of(List.of("probe"));
        }
        if (t.contains("node or string array")) {
            return List.of(List.of("probe"));
        }
        if (t.contains("node array")) {
            return List.of(List.of(new UiNode("text", entry("text", "probe"), List.of())));
        }
        if (t.contains("array")) {
            // The item/section/span/column/target/shadow shapes.
            return List.of(List.of(fatItem()));
        }
        if (t.contains("node")) {
            return List.of(new UiNode("text", entry("text", "probe"), List.of()));
        }
        if (t.contains("object") || t.contains("border spec") || t.contains("style map")) {
            return List.of(fatObject());
        }
        if (t.contains("num") || t.contains("int")) {
            return List.of(3, 0);
        }
        if (t.contains("wrap alignment")) {
            return List.of("start", "spaceBetween");
        }
        if (t.contains("alignment")) {
            return List.of("topLeft", "center");
        }
        if (t.contains("text align")) {
            return List.of("center");
        }
        if (t.contains("keyboard")) {
            return List.of("email", "number");
        }
        if (t.contains("clip")) {
            return List.of("hardEdge", "none");
        }
        if (t.contains("padding")) {
            return List.of(8);
        }
        if (t.contains("color")) {
            return List.of("#123456");
        }
        if (t.contains("icon name")) {
            return List.of("check");
        }
        List<Object> values = new ArrayList<>();
        Matcher literal = BACKTICK.matcher(pair.type());
        while (literal.find()) {
            values.add(literal.group(1));
        }
        values.add("probe");
        values.add(3);
        return values;
    }

    /** The fat item map: every key any section 2.6 item shape may read. */
    private static Map<String, Object> fatItem() {
        return entry(
                "label", "L", "value", 3, "text", "T", "kind", "add", "color", "#123456",
                "header", "@@", "oldNo", 1, "newNo", 1, "src", "x.png", "icon", "check",
                "id", "x", "count", 1, "section", "S", "stat", "+1", "duration", 1000,
                "values", List.of(3, 1),
                "lines", List.of(entry("kind", "add", "oldNo", 1, "newNo", 1, "text", "t")));
    }

    /** The fat object map: every key any section 2.6 object shape may read. */
    private static Map<String, Object> fatObject() {
        return entry(
                "size", 12, "height", 1.2, "leading", 2, "column", "c", "ascending", true,
                "key", "k", "minChars", 2, "minWidth", 10, "copy", true, "style", "outline",
                "width", 2, "radius", 4, "color", "#123456", "type", "linear",
                "begin", "topLeft", "end", "bottomRight", "colors", List.of("#ff0000", "#00ff00"));
    }

    // --- gallery fixtures -------------------------------------------------

    /** One representative node per §2.5 name; the universal names carry their prop. */
    private static UiNode representative(String name) {
        UiNode probe = new UiNode("text", entry("text", "probe"), List.of());
        switch (name) {
            case "glass":
                return new UiNode("card", entry("title", "Glass", "glass", true), List.of(probe));
            case "demo":
                return new UiNode("button", entry("label", "Demo", "demo", true,
                        "action", entry("path", "/ui/action/a", "name", "a")), List.of());
            case "statusPulse":
                return new UiNode("progress",
                        entry("kind", "linear", "value", 0.5, "statusPulse", "pulse"), List.of());
            case "safeArea":
                return new UiNode("box", entry("safeArea", true), List.of(probe));
            case "screen":
                return new UiNode("screen", entry("title", "Screen", "body", probe), List.of());
            case "shell":
                return new UiNode("shell", entry("body", probe), List.of());
            case "container":
                return new UiNode("container",
                        entry("direction", "row", "gap", 8), List.of(probe));
            case "box":
                return new UiNode("box", entry("child", probe), List.of());
            case "row":
                return new UiNode("row", entry("children", List.of(probe)), List.of());
            case "column":
                return new UiNode("column", entry("children", List.of(probe)), List.of());
            case "flex":
                return new UiNode("flex", entry("direction", "row",
                        "children", List.of(probe)), List.of());
            case "expanded":
                return new UiNode("expanded", entry("flex", 2, "child", probe), List.of());
            case "flexible":
                return new UiNode("flexible", entry("fit", "tight", "child", probe), List.of());
            case "stack":
                return new UiNode("stack", entry("alignment", "topLeft",
                        "children", List.of(probe)), List.of());
            case "positioned":
                return new UiNode("positioned",
                        entry("top", 4, "left", 4, "child", probe), List.of());
            case "align":
                return new UiNode("align", entry("align", "center", "child", probe), List.of());
            case "center":
                return new UiNode("center", entry("child", probe), List.of());
            case "sized_box":
                return new UiNode("sized_box", entry("width", 40, "height", 20, "child", probe),
                        List.of());
            case "aspect_ratio":
                return new UiNode("aspect_ratio",
                        entry("aspectRatio", 1.5, "child", probe), List.of());
            case "wrap":
                return new UiNode("wrap", entry("direction", "horizontal",
                        "spacing", 4, "runSpacing", 8, "children", List.of(probe)), List.of());
            case "grid":
                return new UiNode("grid", entry("columns", 2,
                        "children", List.of(probe, probe)), List.of());
            case "scroll":
                return new UiNode("scroll", entry("children", List.of(probe)), List.of());
            case "divider":
                return new UiNode("divider", entry("thickness", 2, "indent", 4), List.of());
            case "spacer":
                return new UiNode("spacer", entry("axis", "horizontal", "size", 8), List.of());
            case "list":
                return new UiNode("list", entry("items", List.of("one", "two"),
                        "separator", new UiNode("divider", Map.of(), List.of())), List.of());
            case "list_row":
                return new UiNode("list_row", entry("title", "Row", "subtitle", "Sub",
                        "statusIndicators", List.of("working"), "selected", true), List.of());
            case "table":
                return new UiNode("table", entry(
                        "columns", List.of(entry("label", "Name", "sortable", true)),
                        "rows", List.of(List.of("a"))), List.of());
            case "tree":
                return new UiNode("tree", entry("items", List.of(
                        entry("label", "src", "icon", "folder", "expanded", true,
                                "items", List.of(entry("label", "a.java"))))), List.of());
            case "split":
                return new UiNode("split", entry("first", probe, "second", probe,
                        "axis", "horizontal", "handleStyle", "grip"), List.of());
            case "text":
                return new UiNode("text", entry("text", "Hello", "style", "h2",
                        "bold", true, "maxLines", 2), List.of());
            case "rich_text":
                return new UiNode("rich_text", entry("spans", List.of(
                        entry("text", "Hello "),
                        entry("text", "link", "action",
                                entry("path", "/ui/action/a", "name", "a"),
                                "style", entry("fontWeight", 700)))), List.of());
            case "markdown":
                return new UiNode("markdown", entry("text", "# Title\n\nBody"), List.of());
            case "code_block":
                return new UiNode("code_block", entry("code", "int x = 1;",
                        "language", "java", "copyable", true), List.of());
            case "button":
                return new UiNode("button", entry("label", "Go", "style", "primary",
                        "action", entry("path", "/ui/action/a", "name", "a")), List.of());
            case "icon_button":
                return new UiNode("icon_button", entry("icon", "check",
                        "isSelected", true), List.of());
            case "icon":
                return new UiNode("icon", entry("icon", "check", "size", 16), List.of());
            case "input":
                return new UiNode("input", entry("id", "f", "label", "Field",
                        "value", "v", "required", true, "min", 1, "max", 9,
                        "pattern", "[0-9]+", "errorText", "bad"), List.of());
            case "textarea":
                return new UiNode("textarea", entry("id", "t", "label", "Notes",
                        "value", "text"), List.of());
            case "dropdown":
                return new UiNode("dropdown", entry("id", "d",
                        "items", List.of(entry("label", "A", "value", "a")),
                        "hint", "Pick"), List.of());
            case "checkbox":
                return new UiNode("checkbox", entry("id", "c", "label", "Check",
                        "value", true), List.of());
            case "switch":
                return new UiNode("switch", entry("id", "s", "label", "Toggle",
                        "value", true), List.of());
            case "slider":
                return new UiNode("slider", entry("id", "sl", "min", 0, "max", 10,
                        "value", 5, "step", 1), List.of());
            case "form":
                return new UiNode("form", entry(
                        "fields", List.of(new UiNode("input",
                                entry("id", "f", "label", "F"), List.of())),
                        "submit", entry("label", "Send",
                                "action", entry("path", "/ui/action/a", "name", "a"))), List.of());
            case "segmented":
                return new UiNode("segmented", entry("value", "a", "segments", List.of(
                        entry("label", "A", "value", "a"),
                        entry("label", "B", "value", "b"))), List.of());
            case "menu":
                return new UiNode("menu", entry(
                        "trigger", new UiNode("button", entry("label", "Menu"), List.of()),
                        "items", List.of(entry("label", "Open", "icon", "check"),
                                entry("divider", true))), List.of());
            case "tabs":
                return new UiNode("tabs", entry("id", "t", "activeIndex", 1, "items", List.of(
                        entry("label", "One", "panel", probe),
                        entry("label", "Two", "panel", probe))), List.of());
            case "kbd":
                return new UiNode("kbd", entry("chord", "mod+shift+enter"), List.of());
            case "scroll_fade":
                return new UiNode("scroll_fade", entry("edge", "top", "mode", "topbar",
                        "child", probe), List.of());
            case "card":
                return new UiNode("card", entry("title", "Card"), List.of(probe));
            case "drawer":
                return new UiNode("drawer", entry("title", "Drawer"), List.of(probe));
            case "sheet":
                return new UiNode("sheet", entry("title", "Sheet", "body", probe,
                        "dismissible", false), List.of());
            case "dialog":
                return new UiNode("dialog", entry("title", "Dialog", "content", probe,
                        "actions", List.of(new UiNode("button", entry("label", "OK"),
                                List.of()))), List.of());
            case "banner":
                return new UiNode("banner", entry("content", probe,
                        "onDismiss", entry("path", "/ui/action/a", "name", "a")), List.of());
            case "chip":
                return new UiNode("chip", entry("label", "Chip", "kind", "file",
                        "variant", "assist", "selected", true), List.of());
            case "badge":
                return new UiNode("badge", entry("count", 120, "max", 99), List.of());
            case "avatar":
                return new UiNode("avatar", entry("initials", "AB", "size", 32,
                        "shape", "circle"), List.of());
            case "skeleton":
                return new UiNode("skeleton", entry("variant", "text", "lines", 3), List.of());
            case "progress":
                return new UiNode("progress", entry("kind", "linear", "value", 0.25), List.of());
            case "image":
                return new UiNode("image", entry("src", "x.png", "fit", "cover",
                        "width", 40, "height", 30), List.of());
            case "figure":
                return new UiNode("figure", entry("shape", "triangle", "color", "#123456",
                        "width", 20, "height", 20), List.of());
            case "hover_card":
                return new UiNode("hover_card", entry("trigger", probe, "content", probe,
                        "delay", 300, "placement", "top"), List.of());
            case "toast_stack":
                return new UiNode("toast_stack", entry("direction", "bottom", "items",
                        List.of(entry("text", "Saved", "style", "success"))), List.of());
            case "stream_view":
                return new UiNode("stream_view", entry("id", "sv", "topic", "/ui/stream/t",
                        "mode", "append", "autoScroll", true), List.of());
            case "chart_line":
                return new UiNode("chart_line", entry("series", List.of(
                        entry("label", "tokens", "values", List.of(1, 3, 2)))), List.of());
            case "chart_bar":
                return new UiNode("chart_bar", entry("items", List.of(
                        entry("label", "a", "value", 4),
                        entry("label", "b", "value", 8))), List.of());
            case "chart_pie":
                return new UiNode("chart_pie", entry("items", List.of(
                        entry("label", "a", "value", 1),
                        entry("label", "b", "value", 3))), List.of());
            case "diff_view":
                return new UiNode("diff_view", entry(
                        "file", "a.txt", "language", "text", "demo", true,
                        "stats", entry("additions", 1, "deletions", 1),
                        "hunks", List.of(entry("header", "@@ -1 +1 @@",
                                "lines", List.of(entry("kind", "add", "oldNo", 1,
                                        "newNo", 1, "text", "line"))))), List.of());
            case "nav":
                return new UiNode("nav", entry("kind", "tabs", "activeIndex", 0, "items",
                        List.of(entry("label", "Home", "icon", "home"),
                                entry("label", "Settings"))), List.of());
            default:
                // A prop-less node of the catalog name (the empty primitives
                // and any name not worth a prop-heavy fixture).
                return new UiNode(name, new LinkedHashMap<>(), List.of());
        }
    }

    /** An insertion-ordered map literal (Map.of randomizes iteration order). */
    private static Map<String, Object> entry(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put((String) keyValues[i], keyValues[i + 1]);
        }
        return map;
    }

    /** The committed fixture bytes from the test classpath. */
    private static byte[] fixture(String name) {
        try (InputStream in = HtmlConformanceTest.class
                .getResourceAsStream("/gallery/" + name + ".html")) {
            assertThat(in).as("committed fixture gallery/%s.html exists", name).isNotNull();
            return in.readAllBytes();
        } catch (IOException failure) {
            throw new UncheckedIOException("cannot read fixture " + name, failure);
        }
    }
}
