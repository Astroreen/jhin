/**
 * The enum literal sets of the SDUI contract and the single place where the
 * builder is allowed to throw: enum-typed setters validate their literal
 * against these sets and raise {@link IllegalArgumentException} on an unknown
 * value. The sets mirror docs/sdui.md sections 2.1 and 2.6; the conformance
 * test keeps the prop keys from drifting, this class keeps the literals from
 * drifting.
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.Map;
import java.util.Set;

final class UiEnums {

    /** docs/sdui.md 2.1 Box {@code clip} and Flex {@code clipBehavior}. */
    static final Set<String> CLIP =
            Set.of("none", "hardEdge", "softEdge", "antiAlias", "antiAliasWithSaveLayer");

    /** docs/sdui.md 2.1 Box {@code borderStyle}. */
    static final Set<String> BORDER_STYLE = Set.of("solid", "none");

    /** docs/sdui.md 2.1 Text {@code fontStyle}. */
    static final Set<String> FONT_STYLE = Set.of("normal", "italic");

    /** docs/sdui.md 2.1 Text {@code textAlign}. */
    static final Set<String> TEXT_ALIGN = Set.of("left", "right", "center", "justify", "start", "end");

    /** docs/sdui.md 2.1 Text {@code textDecoration}. */
    static final Set<String> TEXT_DECORATION = Set.of("none", "underline", "overline", "lineThrough");

    /** docs/sdui.md 2.1 Text {@code textOverflow}. */
    static final Set<String> TEXT_OVERFLOW = Set.of("clip", "fade", "ellipsis", "visible");

    /** docs/sdui.md 2.1 Flex {@code fit}. */
    static final Set<String> FLEX_FIT = Set.of("loose", "tight");

    /** docs/sdui.md 2.1 Flex {@code mainAxisSize}. */
    static final Set<String> MAIN_AXIS_SIZE = Set.of("min", "max");

    /** docs/sdui.md 2.1 Flex {@code mainAxisAlignment}. */
    static final Set<String> MAIN_AXIS =
            Set.of("start", "end", "center", "spaceBetween", "spaceAround", "spaceEvenly");

    /** docs/sdui.md 2.1 Flex {@code crossAxisAlignment}. */
    static final Set<String> CROSS_AXIS = Set.of("start", "end", "center", "stretch", "baseline");

    /** docs/sdui.md 2.1 Flex {@code direction}. */
    static final Set<String> FLEX_DIRECTION = Set.of("row", "column");

    /** docs/sdui.md 2.1 Flex {@code textDirection}. */
    static final Set<String> TEXT_DIRECTION = Set.of("ltr", "rtl");

    /** docs/sdui.md 2.1 Flex {@code verticalDirection}. */
    static final Set<String> VERTICAL_DIRECTION = Set.of("up", "down");

    /** docs/sdui.md 2.1 Flex {@code textBaseline}. */
    static final Set<String> TEXT_BASELINE = Set.of("alphabetic", "ideographic");

    /** docs/sdui.md 2.1 Flex {@code overflow}. */
    static final Set<String> OVERFLOW = Set.of("visible", "clip", "fade", "ellipsis");

    /** docs/sdui.md 2.1 Interaction {@code cursor} and the per-primitive {@code mouseCursor}. */
    static final Set<String> CURSOR = Set.of(
            "system", "none", "click", "text", "forbidden", "grab", "grabbing", "wait", "precise",
            "allScroll", "resizeUpDown", "resizeLeftRight", "alias", "cell", "contextMenu", "copy",
            "help", "move", "noDrop", "progress", "zoomIn", "zoomOut");

    /** Alignment literals, as parsed by the client registry (docs/sdui.md 2.1 Box {@code align}). */
    static final Set<String> ALIGNMENT = Set.of(
            "topLeft", "topCenter", "topRight",
            "centerLeft", "center", "centerRight",
            "bottomLeft", "bottomCenter", "bottomRight");

    /** docs/sdui.md 2.6 text legacy {@code style} typography token. */
    static final Set<String> TEXT_STYLE = Set.of("h1", "h2", "h3", "body", "small", "caption", "mono");

    /** docs/sdui.md 2.6 button {@code style}. */
    static final Set<String> BUTTON_STYLE = Set.of("primary", "secondary", "danger", "text");

    /** docs/sdui.md 2.6 progress {@code kind}. */
    static final Set<String> PROGRESS_KIND = Set.of("linear", "circular");

    /** docs/sdui.md 2.6 stream_view {@code mode}. */
    static final Set<String> STREAM_MODE = Set.of("append", "replace");

    /** docs/sdui.md 2.6 image {@code fit}. */
    static final Set<String> BOX_FIT =
            Set.of("cover", "contain", "fill", "fitWidth", "fitHeight", "none", "scaleDown");

    /** docs/sdui.md 2.6 figure {@code shape}. */
    static final Set<String> FIGURE_SHAPE = Set.of("rectangle", "circle", "triangle");

    /** docs/sdui.md 2.6 nav {@code kind}. */
    static final Set<String> NAV_KIND = Set.of("tabs", "bottom", "drawer", "rail", "sidebar");

    /** docs/sdui.md 2.6 input {@code keyboardType} (and the legacy {@code keyboard} spelling). */
    static final Set<String> KEYBOARD_TYPE =
            Set.of("text", "number", "phone", "email", "url", "visiblePassword", "multiline");

    /** docs/sdui.md 2.6 input {@code textInputAction} (the doc lists the common subset; the rest are the Flutter IME actions). */
    static final Set<String> TEXT_INPUT_ACTION = Set.of(
            "none", "unspecified", "done", "go", "next", "previous", "search", "send", "newline",
            "continueAction", "join", "route");

    /** docs/sdui.md 2.6 input {@code textCapitalization}. */
    static final Set<String> TEXT_CAPITALIZATION = Set.of("none", "words", "sentences", "characters");

    /** docs/sdui.md 2.6 input {@code maxLengthEnforcement}. */
    static final Set<String> MAX_LENGTH_ENFORCEMENT =
            Set.of("none", "enforced", "truncateAfterCompositionEnds");

    /** docs/sdui.md 2.6 input {@code border}/{@code enabledBorder}/{@code focusedBorder}/{@code errorBorder} spec. */
    static final Set<String> INPUT_BORDER = Set.of("underline", "outline", "none");

    /** docs/sdui.md 2.6 text {@code textWidthBasis}. */
    static final Set<String> TEXT_WIDTH_BASIS = Set.of("parent", "longestLine", "character");

    /** docs/sdui.md 2.6 form {@code autovalidateMode}. */
    static final Set<String> AUTOVALIDATE_MODE = Set.of("disabled", "always", "onUserInteraction");

    /** docs/sdui.md 2.6 spacer {@code axis}. */
    static final Set<String> SPACER_AXIS = Set.of("vertical", "horizontal");

    /** docs/sdui.md 2.1 Box {@code gradient} type. */
    static final Set<String> GRADIENT_TYPE = Set.of("linear", "radial", "sweep");

    /** Builder-specific literal overrides: entries are {@code <BuilderSimpleName>.<prop>}. */
    private static final Map<String, Set<String>> SPECIFIC = Map.of(
            "ButtonBuilder.style", BUTTON_STYLE,
            "ImageBuilder.fit", BOX_FIT,
            "NavBuilder.kind", NAV_KIND,
            "InputBuilder.border", INPUT_BORDER,
            "InputBuilder.enabledBorder", INPUT_BORDER,
            "InputBuilder.focusedBorder", INPUT_BORDER,
            "InputBuilder.errorBorder", INPUT_BORDER);

    /** Global prop-name to literal-set lookup, used by the conformance probe. */
    private static final Map<String, Set<String>> BY_KEY = Map.ofEntries(
            Map.entry("clip", CLIP),
            Map.entry("clipBehavior", CLIP),
            Map.entry("borderStyle", BORDER_STYLE),
            Map.entry("fontStyle", FONT_STYLE),
            Map.entry("textAlign", TEXT_ALIGN),
            Map.entry("textDecoration", TEXT_DECORATION),
            Map.entry("textOverflow", TEXT_OVERFLOW),
            Map.entry("overflow", OVERFLOW),
            Map.entry("fit", FLEX_FIT),
            Map.entry("mainAxisSize", MAIN_AXIS_SIZE),
            Map.entry("mainAxisAlignment", MAIN_AXIS),
            Map.entry("crossAxisAlignment", CROSS_AXIS),
            Map.entry("direction", FLEX_DIRECTION),
            Map.entry("textDirection", TEXT_DIRECTION),
            Map.entry("verticalDirection", VERTICAL_DIRECTION),
            Map.entry("textBaseline", TEXT_BASELINE),
            Map.entry("cursor", CURSOR),
            Map.entry("mouseCursor", CURSOR),
            Map.entry("align", ALIGNMENT),
            Map.entry("alignment", ALIGNMENT),
            Map.entry("style", TEXT_STYLE),
            Map.entry("kind", PROGRESS_KIND),
            Map.entry("mode", STREAM_MODE),
            Map.entry("shape", FIGURE_SHAPE),
            Map.entry("keyboard", KEYBOARD_TYPE),
            Map.entry("keyboardType", KEYBOARD_TYPE),
            Map.entry("textInputAction", TEXT_INPUT_ACTION),
            Map.entry("textCapitalization", TEXT_CAPITALIZATION),
            Map.entry("maxLengthEnforcement", MAX_LENGTH_ENFORCEMENT),
            Map.entry("textWidthBasis", TEXT_WIDTH_BASIS),
            Map.entry("autovalidateMode", AUTOVALIDATE_MODE),
            Map.entry("axis", SPACER_AXIS));

    private UiEnums() {
    }

    /**
     * Validates one enum literal.
     *
     * @param prop     the wire key, for the message
     * @param value    the literal to validate
     * @param literals the accepted literals
     * @return the validated value, unchanged
     * @throws IllegalArgumentException when the value is null or unknown
     */
    static String require(String prop, String value, Set<String> literals) {
        if (value == null || !literals.contains(value)) {
            throw new IllegalArgumentException(
                    "unknown " + prop + " literal: " + value
                            + "; expected one of " + String.join(", ", literals.stream().sorted().toList()));
        }
        return value;
    }

    /**
     * A sample literal for the conformance probe: the builder-specific set
     * when one exists, else the global set for the prop name.
     */
    static String sample(Class<?> builder, String prop) {
        Set<String> specific = SPECIFIC.get(builder.getSimpleName() + "." + prop);
        Set<String> literals = specific != null ? specific : BY_KEY.get(prop);
        return literals != null ? literals.iterator().next() : "$spacing.md";
    }
}
