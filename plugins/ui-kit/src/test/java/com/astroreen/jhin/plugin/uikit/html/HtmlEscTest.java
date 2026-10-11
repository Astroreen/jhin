/**
 * Escaping matrix of {@link HtmlEsc}: the five significant characters, the
 * XSS payloads that must never survive into markup, null/empty handling and
 * order-safety of the transformation.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HtmlEscTest {

    @Test
    void scriptTagIsEscapedInTextContent() {
        assertThat(HtmlEsc.text("<script>alert(1)</script>"))
                .isEqualTo("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    @Test
    void scriptTagIsEscapedInDoubleQuotedAttribute() {
        assertThat(HtmlEsc.attr("<script>alert(1)</script>"))
                .isEqualTo("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    @Test
    void scriptTagIsEscapedInSingleQuotedAttribute() {
        assertThat(HtmlEsc.attrSingle("<script>alert(1)</script>"))
                .isEqualTo("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    @Test
    void apostropheCannotBreakOutOfSingleQuotedAttribute() {
        assertThat(HtmlEsc.attrSingle("x' onmouseover='alert(1)"))
                .isEqualTo("x&#39; onmouseover=&#39;alert(1)");
        assertThat(HtmlEsc.attrSingle("'-alert(1)-'"))
                .isEqualTo("&#39;-alert(1)-&#39;");
    }

    @Test
    void ampersandAloneBecomesEntity() {
        assertThat(HtmlEsc.text("&")).isEqualTo("&amp;");
        assertThat(HtmlEsc.attr("&")).isEqualTo("&amp;");
        assertThat(HtmlEsc.attrSingle("&")).isEqualTo("&amp;");
    }

    @Test
    void lessThanAloneBecomesEntity() {
        assertThat(HtmlEsc.text("<")).isEqualTo("&lt;");
        assertThat(HtmlEsc.attr("<")).isEqualTo("&lt;");
        assertThat(HtmlEsc.attrSingle("<")).isEqualTo("&lt;");
    }

    @Test
    void quotesMixedWithAmpersandsAreEscapedTogether() {
        String input = "&\"'<>&";
        String expected = "&amp;&quot;&#39;&lt;&gt;&amp;";
        assertThat(HtmlEsc.text(input)).isEqualTo(expected);
        assertThat(HtmlEsc.attr(input)).isEqualTo(expected);
        assertThat(HtmlEsc.attrSingle(input)).isEqualTo(expected);
    }

    @Test
    void emptyStringStaysEmpty() {
        assertThat(HtmlEsc.text("")).isEmpty();
        assertThat(HtmlEsc.attr("")).isEmpty();
        assertThat(HtmlEsc.attrSingle("")).isEmpty();
    }

    @Test
    void nullBecomesEmptyString() {
        assertThat(HtmlEsc.text(null)).isEmpty();
        assertThat(HtmlEsc.attr(null)).isEmpty();
        assertThat(HtmlEsc.attrSingle(null)).isEmpty();
    }

    @Test
    void longMixedStringEscapesToExactOutput() {
        String input = "Tom & Jerry's \"show\" <tag> & more &amp; stuff ' \" < > end";
        String expected = "Tom &amp; Jerry&#39;s &quot;show&quot; &lt;tag&gt; &amp; more"
                + " &amp;amp; stuff &#39; &quot; &lt; &gt; end";
        assertThat(HtmlEsc.text(input)).isEqualTo(expected);
        assertThat(HtmlEsc.attr(input)).isEqualTo(expected);
        assertThat(HtmlEsc.attrSingle(input)).isEqualTo(expected);
    }
}
