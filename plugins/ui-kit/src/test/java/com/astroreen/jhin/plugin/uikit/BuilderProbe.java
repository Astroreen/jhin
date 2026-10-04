package com.astroreen.jhin.plugin.uikit;

import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Supplier;

/**
 * The reflection probe behind the conformance test: walks every builder
 * class, invokes every setter with a plausible value and collects the wire
 * keys the builders can emit. Shared by {@link UiConformanceTest} (key
 * inventory) and {@link UiLatticeTest} (per-method wire-key assertions).
 */
final class BuilderProbe {

    private static final Set<String> SKIP = Set.of(
            "build", "props", "set", "wait", "notify", "notifyAll",
            "getClass", "hashCode", "equals", "toString");

    private BuilderProbe() {
    }

    /** One supplier per builder class; the probe instantiates each through its Ui factory. */
    static final Map<Class<?>, Supplier<Object>> BUILDERS = new LinkedHashMap<>();

    static {
        BUILDERS.put(Ui.ScreenBuilder.class, Ui::screen);
        BUILDERS.put(Ui.NavBuilder.class, Ui::nav);
        BUILDERS.put(Ui.ContainerBuilder.class, Ui::container);
        BUILDERS.put(Ui.CardBuilder.class, Ui::card);
        BUILDERS.put(Ui.TextBuilder.class, () -> Ui.text("probe"));
        BUILDERS.put(Ui.MarkdownBuilder.class, () -> Ui.markdown("probe"));
        BUILDERS.put(Ui.RichTextBuilder.class, Ui::richText);
        BUILDERS.put(Ui.CodeBlockBuilder.class, () -> Ui.codeBlock("probe"));
        BUILDERS.put(Ui.ButtonBuilder.class, () -> Ui.button("probe"));
        BUILDERS.put(Ui.InputBuilder.class, () -> Ui.input("probe"));
        BUILDERS.put(Ui.DropdownBuilder.class, () -> Ui.dropdown("probe"));
        BUILDERS.put(Ui.CheckboxBuilder.class, () -> Ui.checkbox("probe", "probe"));
        BUILDERS.put(Ui.ToggleBuilder.class, () -> Ui.toggle("probe", "probe"));
        BUILDERS.put(Ui.SliderBuilder.class, () -> Ui.slider("probe", 0, 1));
        BUILDERS.put(Ui.FormBuilder.class, Ui::form);
        BUILDERS.put(Ui.ListBuilder.class, Ui::list);
        BUILDERS.put(Ui.StreamViewBuilder.class, () -> Ui.streamView("probe", "/probe"));
        BUILDERS.put(Ui.TableBuilder.class, Ui::table);
        BUILDERS.put(Ui.DividerBuilder.class, Ui::divider);
        BUILDERS.put(Ui.SpacerBuilder.class, Ui::spacer);
        BUILDERS.put(Ui.ProgressBuilder.class, Ui::progress);
        BUILDERS.put(Ui.ImageBuilder.class, Ui::image);
        BUILDERS.put(Ui.FigureBuilder.class, Ui::figure);
        BUILDERS.put(Ui.ChartLineBuilder.class, Ui::chartLine);
        BUILDERS.put(Ui.ChartBarBuilder.class, Ui::chartBar);
        BUILDERS.put(Ui.ChartPieBuilder.class, Ui::chartPie);
        BUILDERS.put(Ui.DrawerBuilder.class, Ui::drawer);
        BUILDERS.put(Ui.BoxBuilder.class, Ui::box);
        BUILDERS.put(Ui.RowBuilder.class, Ui::row);
        BUILDERS.put(Ui.ColumnBuilder.class, Ui::column);
        BUILDERS.put(Ui.FlexBuilder.class, () -> Ui.flex("row"));
        BUILDERS.put(Ui.ExpandedBuilder.class, Ui::expanded);
        BUILDERS.put(Ui.FlexibleBuilder.class, Ui::flexible);
        BUILDERS.put(Ui.SizedBoxBuilder.class, Ui::sizedBox);
        BUILDERS.put(Ui.AlignBuilder.class, Ui::align);
        BUILDERS.put(Ui.CenterBuilder.class, Ui::center);
        BUILDERS.put(Ui.AspectRatioBuilder.class, () -> Ui.aspectRatio(1.5));
        BUILDERS.put(Ui.StackBuilder.class, Ui::stack);
        BUILDERS.put(Ui.PositionedBuilder.class, Ui::positioned);
        BUILDERS.put(Ui.WrapBuilder.class, Ui::wrap);
        BUILDERS.put(Ui.GridBuilder.class, Ui::grid);
        BUILDERS.put(Ui.ScrollBuilder.class, Ui::scroll);
        BUILDERS.put(Ui.IconBuilder.class, Ui::icon);
        BUILDERS.put(Ui.IconButtonBuilder.class, Ui::iconButton);
        BUILDERS.put(Ui.ListRowBuilder.class, Ui::listRow);
        BUILDERS.put(Ui.BadgeBuilder.class, Ui::badge);
        BUILDERS.put(Ui.ChipBuilder.class, Ui::chip);
        BUILDERS.put(Ui.AvatarBuilder.class, Ui::avatar);
        BUILDERS.put(Ui.SkeletonBuilder.class, Ui::skeleton);
        BUILDERS.put(Ui.MenuBuilder.class, Ui::menu);
        BUILDERS.put(Ui.SheetBuilder.class, Ui::sheet);
        BUILDERS.put(Ui.DialogBuilder.class, Ui::dialog);
        BUILDERS.put(Ui.BannerBuilder.class, Ui::banner);
    }

    /**
     * Invokes every setter of every builder on a fresh instance and returns
     * the wire keys each builder can emit, collected recursively from the
     * JSON shape (top-level props, nested spec maps and item entries).
     */
    static Map<Class<?>, Set<String>> probeAllKeys() {
        Map<Class<?>, Set<String>> keys = new LinkedHashMap<>();
        for (Map.Entry<Class<?>, Supplier<Object>> entry : BUILDERS.entrySet()) {
            Object builder = entry.getValue().get();
            for (Method method : setterMethods(entry.getKey())) {
                invoke(builder, entry.getKey(), method);
            }
            UiNode node = ((Ui.NodeBuilder<?>) builder).build();
            Set<String> collected = new TreeSet<>();
            collectKeys(node.toJson(), collected);
            keys.put(entry.getKey(), collected);
        }
        return keys;
    }

    /** The public single- to three-argument fluent setters of one builder class. */
    static List<Method> setterMethods(Class<?> builder) {
        Set<String> seen = new HashSet<>();
        List<Method> methods = new ArrayList<>();
        for (Method method : builder.getMethods()) {
            if (method.isBridge() || method.isSynthetic()
                    || Modifier.isStatic(method.getModifiers())
                    || method.getDeclaringClass() == Object.class
                    || method.getParameterCount() < 1 || method.getParameterCount() > 3
                    || method.getReturnType() == void.class
                    || SKIP.contains(method.getName())) {
                continue;
            }
            String signature = method.getName() + Arrays.toString(method.getParameterTypes());
            if (seen.add(signature)) {
                methods.add(method);
            }
        }
        return methods;
    }

    /**
     * Invokes one setter with a plausible value per parameter. Enum-typed
     * string props get a literal from {@link UiEnums#sample}; composite spec
     * props (gradient, shadow) get a real spec so their nested keys are
     * collected too.
     */
    static void invoke(Object builder, Class<?> builderClass, Method method) {
        Class<?>[] types = method.getParameterTypes();
        Object[] args = new Object[types.length];
        for (int i = 0; i < types.length; i++) {
            args[i] = valueFor(builderClass, method, types[i]);
        }
        try {
            method.invoke(builder, args);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(
                    "probe failed to invoke " + builderClass.getSimpleName() + "." + method.getName(), e);
        }
    }

    /** A plausible value for one setter parameter. */
    static Object valueFor(Class<?> builderClass, Method method, Class<?> type) {
        if (type == boolean.class) {
            return true;
        }
        if (type == int.class || type == long.class) {
            return 1;
        }
        if (type == double.class || type == float.class) {
            return 1.5;
        }
        if (Number.class.isAssignableFrom(type)) {
            return 1;
        }
        if (type == String.class) {
            return UiEnums.sample(builderClass, method.getName());
        }
        if (type == UiNode.class) {
            return Ui.text("probe").build();
        }
        if (type == List.class) {
            return List.of();
        }
        if (type == Map.class) {
            return mapFor(method.getName());
        }
        if (type == Object.class) {
            return objectFor(method.getName());
        }
        if (type.isArray()) {
            return Array.newInstance(type.getComponentType(), 0);
        }
        throw new IllegalStateException(
                "probe cannot supply a value for " + type + " (" + method.getName() + ")");
    }

    private static Map<String, Object> mapFor(String prop) {
        return switch (prop) {
            case "gradient" -> UiTokens.gradient(
                    "linear", List.of("$color.accent", "$color.accentMuted"), List.of("0", "1"),
                    "topLeft", "bottomRight");
            case "shadow" -> UiTokens.shadow("$color.shadow", 12, 0, 0, 4);
            default -> Map.of();
        };
    }

    private static Object objectFor(String prop) {
        return switch (prop) {
            case "transform" -> List.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
            case "style", "decoration", "constraints", "sort", "strutStyle", "toolbarOptions" -> Map.of();
            default -> 1;
        };
    }

    /** The wire key a fluent setter writes: children/items arrays or the method name. */
    static String wireKey(Method method) {
        String name = method.getName();
        if (name.equals("child") || name.equals("children")) {
            return "children";
        }
        if (name.startsWith("item")) {
            return "items";
        }
        return name;
    }

    private static void collectKeys(Map<String, Object> json, Set<String> into) {
        for (Map.Entry<String, Object> entry : json.entrySet()) {
            into.add(entry.getKey());
            collectValue(entry.getValue(), into);
        }
    }

    private static void collectValue(Object value, Set<String> into) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                into.add(String.valueOf(entry.getKey()));
                collectValue(entry.getValue(), into);
            }
        } else if (value instanceof List<?> list) {
            for (Object element : list) {
                collectValue(element, into);
            }
        }
    }
}
