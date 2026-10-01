/**
 * Wire shape of {@link UiNode}: prop and child serialization, the string child
 * shorthand, recursive conversion of nodes nested in props, and the defensive
 * copies taken at construction.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UiNodeTest {

    @Test
    void toJsonWritesTypePropsAndChildrenInOrder() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("text", "Hello");
        props.put("style", "h2");
        UiNode node = new UiNode("text", props, List.of());

        assertThat(new ArrayList<>(node.toJson().keySet()))
                .containsExactly("type", "text", "style");
        assertThat(node.toJson()).containsEntry("type", "text");
        assertThat(node.toJson()).containsEntry("text", "Hello");
        assertThat(node.toJson()).containsEntry("style", "h2");
    }

    @Test
    void stringChildStaysAStringOnTheWire() {
        UiNode node = new UiNode("container", Map.of("direction", "column"),
                List.of("plain text", Ui.text("node child").build()));

        Map<String, Object> json = node.toJson();
        assertThat(json).containsKey("children");
        List<Object> children = castList(json.get("children"));
        assertThat(children).hasSize(2);
        assertThat(children.get(0)).isEqualTo("plain text");
        Map<String, Object> childNode = castMap(children.get(1));
        assertThat(childNode).containsEntry("type", "text");
        assertThat(childNode).containsEntry("text", "node child");
    }

    @Test
    void nodesNestedInPropsConvertRecursively() {
        UiNode field = Ui.input("code").label("Code").build();
        UiNode node = new UiNode("form", Map.of("fields", List.of(field)), List.of());

        Map<String, Object> json = node.toJson();
        List<Object> fields = castList(json.get("fields"));
        assertThat(fields).hasSize(1);
        Map<String, Object> first = castMap(fields.get(0));
        assertThat(first).containsEntry("type", "input");
        assertThat(first).containsEntry("id", "code");
        assertThat(first).containsEntry("label", "Code");
    }

    @Test
    void universalFieldsAreOrdinaryProps() {
        UiNode node = Ui.text("Hi").id("t1").visible(false).padding(8).flex(1)
                .when("showHint").build();

        Map<String, Object> json = node.toJson();
        assertThat(json).containsEntry("id", "t1");
        assertThat(json).containsEntry("visible", false);
        assertThat(json).containsEntry("padding", 8);
        assertThat(json).containsEntry("flex", 1);
        assertThat(json).containsEntry("when", "showHint");
    }

    @Test
    void constructionCopiesPropsAndChildren() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("text", "before");
        List<Object> children = new ArrayList<>();
        children.add("kid");
        UiNode node = new UiNode("text", props, children);

        props.put("text", "after");
        children.add("late");

        assertThat(node.props()).containsEntry("text", "before");
        assertThat(node.children()).containsExactly("kid");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
