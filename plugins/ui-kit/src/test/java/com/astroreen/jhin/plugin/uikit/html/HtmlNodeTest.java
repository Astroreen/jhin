/**
 * Rendering contract of {@link HtmlNode}: deterministic attribute order,
 * void elements, recursive children, escaping of attribute values and text
 * children, the raw-child escape hatch and class/style value handling.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class HtmlNodeTest {

    @Test
    void attributesRenderInInsertionOrder() {
        HtmlNode node = new HtmlNode("div")
                .attr("id", "a")
                .attr("class", "b")
                .attr("data-jhin-type", "c");

        assertThat(node.render())
                .isEqualTo("<div id=\"a\" class=\"b\" data-jhin-type=\"c\"></div>");
    }

    @Test
    void voidElementRendersWithoutEndTag() {
        assertThat(new HtmlNode("br").render()).isEqualTo("<br>");
        assertThat(new HtmlNode("img").attr("src", "x.png").render())
                .isEqualTo("<img src=\"x.png\">");
    }

    @Test
    void voidElementRejectsChildren() {
        assertThatThrownBy(() -> new HtmlNode("input").textChild("nope"))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new HtmlNode("hr").child(new HtmlNode("span")))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new HtmlNode("br").rawChild("<i>"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void nestedChildrenRenderRecursively() {
        HtmlNode node = new HtmlNode("div")
                .attr("id", "outer")
                .textChild("hello ")
                .child(new HtmlNode("span").attr("class", "inner").textChild("world"))
                .child(new HtmlNode("ul").child(new HtmlNode("li").textChild("item")));

        assertThat(node.render()).isEqualTo(
                "<div id=\"outer\">hello <span class=\"inner\">world</span>"
                        + "<ul><li>item</li></ul></div>");
    }

    @Test
    void attributeValuesAreEscaped() {
        HtmlNode node = new HtmlNode("div").attr("title", "\"><script>alert(1)</script>");

        assertThat(node.render()).isEqualTo(
                "<div title=\"&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"></div>");
    }

    @Test
    void textChildrenAreEscaped() {
        HtmlNode node = new HtmlNode("span").textChild("<script>alert(1)</script>");

        assertThat(node.render())
                .isEqualTo("<span>&lt;script&gt;alert(1)&lt;/script&gt;</span>");
    }

    @Test
    void rawChildEmitsVerbatim() {
        HtmlNode node = new HtmlNode("div").rawChild("<img onerror=\"alert(1)\">");

        assertThat(node.render()).isEqualTo("<div><img onerror=\"alert(1)\"></div>");
    }

    @Test
    void emptyChildrenRenderOpenAndCloseTag() {
        assertThat(new HtmlNode("div").render()).isEqualTo("<div></div>");
    }

    @Test
    void classAndStyleValuesAreEscapedLikeAnyAttribute() {
        HtmlNode node = new HtmlNode("div")
                .attr("class", "a\"b'c")
                .attr("style", "content: '<x>&'");

        assertThat(node.render()).isEqualTo(
                "<div class=\"a&quot;b&#39;c\" style=\"content: &#39;&lt;x&gt;&amp;&#39;\"></div>");
    }

    @Test
    void singleQuotedAttributesRenderSingleQuotedAndEscaped() {
        HtmlNode node = new HtmlNode("button")
                .attr("data-jhin-type", "button")
                .attrSingle("data-jhin-action", "{\"path\":\"/x\",\"note\":\"it's\"}");

        assertThat(node.render()).isEqualTo(
                "<button data-jhin-type=\"button\" "
                        + "data-jhin-action='{&quot;path&quot;:&quot;/x&quot;,&quot;note&quot;:&quot;it&#39;s&quot;}'"
                        + "></button>");
    }

    @Test
    void singleQuotedAttributeReplacesInPlace() {
        HtmlNode node = new HtmlNode("div")
                .attrSingle("data-jhin-action", "first")
                .attr("id", "x")
                .attrSingle("data-jhin-action", "second");

        assertThat(node.render()).isEqualTo(
                "<div data-jhin-action='second' id=\"x\"></div>");
    }
}
