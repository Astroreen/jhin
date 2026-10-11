/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import java.util.Set;
import java.util.regex.Pattern;
import org.commonmark.ext.gfm.tables.TableBlock;
import org.commonmark.ext.gfm.tables.TableBody;
import org.commonmark.ext.gfm.tables.TableCell;
import org.commonmark.ext.gfm.tables.TableHead;
import org.commonmark.ext.gfm.tables.TableRow;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.node.Block;
import org.commonmark.node.BlockQuote;
import org.commonmark.node.BulletList;
import org.commonmark.node.Code;
import org.commonmark.node.Document;
import org.commonmark.node.Emphasis;
import org.commonmark.node.FencedCodeBlock;
import org.commonmark.node.HardLineBreak;
import org.commonmark.node.Heading;
import org.commonmark.node.HtmlBlock;
import org.commonmark.node.HtmlInline;
import org.commonmark.node.Image;
import org.commonmark.node.IndentedCodeBlock;
import org.commonmark.node.Link;
import org.commonmark.node.LinkReferenceDefinition;
import org.commonmark.node.ListBlock;
import org.commonmark.node.ListItem;
import org.commonmark.node.Node;
import org.commonmark.node.OrderedList;
import org.commonmark.node.Paragraph;
import org.commonmark.node.SoftLineBreak;
import org.commonmark.node.StrongEmphasis;
import org.commonmark.node.Text;
import org.commonmark.node.ThematicBreak;
import org.commonmark.parser.Parser;

/**
 * The {@code markdown} primitive: commonmark parsing with <strong>raw HTML
 * blocks and inline HTML disabled</strong>, rendered to semantic
 * {@link HtmlNode}s (docs/sdui.md sections 2.6, 9.3).
 *
 * <p>The raw-HTML guarantee is enforced in code, not relied on as a default:
 *
 * <ol>
 *   <li>the parser's {@code enabledBlockTypes} set lists every core block
 *       type <em>except</em> {@link HtmlBlock}, so an HTML block never parses
 *       as markup — it becomes paragraph text;</li>
 *   <li>the renderer itself treats any {@link HtmlBlock}/{@link HtmlInline}
 *       that still reaches it as <em>text</em> ({@code textChild}, escaped by
 *       {@code HtmlEsc}) — there is no code path that emits a raw literal as
 *       markup.</li>
 * </ol>
 *
 * <p>Consequences of the pipeline: LLM output, file contents and tool output
 * can never inject markup through a {@code markdown} node. Fenced code
 * renders as {@code <pre><code class="language-x">} (the {@code code_block}
 * markup), headings/lists/tables/links/blockquotes render as semantic HTML,
 * and link/image URLs pass a scheme allow-list ({@code http}, {@code https},
 * {@code mailto} and relative URLs; {@code javascript:} and friends degrade
 * to plain text — XSS safety includes click targets, not just markup).
 *
 * <p>Instances are stateless; the parser is built once and thread-safe.
 */
public final class MarkdownRenderer implements NodeRenderer {

    /** The markdown parser: GFM tables on, raw HTML blocks off. */
    private static final Parser PARSER = Parser.builder()
            .extensions(Set.of(TablesExtension.create()))
            .enabledBlockTypes(Set.of(
                    BlockQuote.class, Heading.class, FencedCodeBlock.class,
                    ThematicBreak.class, ListBlock.class, IndentedCodeBlock.class))
            .build();

    /** A URL scheme prefix ({@code scheme:}) at the start of a reference. */
    private static final Pattern SCHEME = Pattern.compile("^([a-zA-Z][a-zA-Z0-9+.-]*):");

    /** The language token allowed in a {@code language-…} class. */
    private static final Pattern LANGUAGE = Pattern.compile("[a-zA-Z0-9_+#-]+");

    /** Base64 inline images the avatar/image props legitimately carry. */
    private static final Pattern DATA_IMAGE = Pattern.compile(
            "^data:image/(png|jpe?g|gif|webp);base64,", Pattern.CASE_INSENSITIVE);

    @Override
    public String tag(UiNode node) {
        return "div";
    }

    @Override
    public void fill(UiNode node, HtmlNode element) {
        element.attr("class", "jhin-markdown");
        Object text = node.props().get("text");
        if (text != null) {
            appendBlocks(element, String.valueOf(text));
        }
    }

    /**
     * Renders markdown source as semantic block elements appended to the
     * target. A parse never throws: any failure leaves the raw source as
     * plain text (section 2.4 degradation).
     *
     * @param target   the parent element
     * @param markdown the markdown source (untrusted)
     */
    public static void appendBlocks(HtmlNode target, String markdown) {
        if (markdown == null) {
            return;
        }
        Node document;
        try {
            document = PARSER.parse(markdown);
        } catch (RuntimeException failure) {
            target.textChild(markdown);
            return;
        }
        appendBlockChildren(target, document);
    }

    // --- blocks -----------------------------------------------------------

    private static void appendBlockChildren(HtmlNode target, Node parent) {
        for (Node child = parent.getFirstChild(); child != null; child = child.getNext()) {
            appendBlock(target, child);
        }
    }

    private static void appendBlock(HtmlNode target, Node node) {
        switch (node) {
            case Paragraph paragraph -> appendWrapped(target, "p", paragraph);
            case Heading heading -> {
                int level = Math.min(6, Math.max(1, heading.getLevel()));
                appendWrapped(target, "h" + level, heading);
            }
            case FencedCodeBlock fenced -> target.child(codeBlock(
                    fenced.getLiteral(), languageOf(fenced.getInfo())));
            case IndentedCodeBlock indented -> target.child(
                    codeBlock(indented.getLiteral(), null));
            case BlockQuote quote -> {
                HtmlNode element = new HtmlNode("blockquote")
                        .attr("class", "jhin-blockquote");
                appendBlockChildren(element, quote);
                target.child(element);
            }
            case BulletList list -> {
                HtmlNode element = new HtmlNode("ul").attr("class", "jhin-ul");
                appendListItems(element, list);
                target.child(element);
            }
            case OrderedList list -> {
                HtmlNode element = new HtmlNode("ol").attr("class", "jhin-ol");
                Integer start = list.getMarkerStartNumber();
                if (start != null && start != 1) {
                    element.attr("start", String.valueOf(start));
                }
                appendListItems(element, list);
                target.child(element);
            }
            case ThematicBreak ignored -> target.child(
                    new HtmlNode("hr").attr("class", "jhin-divider"));
            case TableBlock table -> appendTable(target, table);
            case HtmlBlock htmlBlock -> {
                // Belt and suspenders: HTML blocks are disabled at parse
                // time; if one ever appears it degrades to escaped text.
                target.textChild(htmlBlock.getLiteral());
            }
            case LinkReferenceDefinition ignored -> {
                // no visible content
            }
            case Document document -> appendBlockChildren(target, document);
            case ListItem listItem -> appendListItem(target, listItem);
            default -> appendBlockChildren(target, node);
        }
    }

    private static HtmlNode codeBlock(String literal, String language) {
        HtmlNode pre = new HtmlNode("pre").attr("class", "jhin-code-block");
        HtmlNode code = new HtmlNode("code");
        if (language != null) {
            code.attr("class", "language-" + language);
        }
        code.textChild(literal == null ? "" : literal);
        return pre.child(code);
    }

    private static void appendListItems(HtmlNode element, ListBlock list) {
        for (Node child = list.getFirstChild(); child != null; child = child.getNext()) {
            if (child instanceof ListItem item) {
                appendListItem(element, item);
            }
        }
    }

    private static void appendListItem(HtmlNode parent, ListItem item) {
        HtmlNode li = new HtmlNode("li").attr("class", "jhin-li");
        Node first = item.getFirstChild();
        boolean tightParagraph = first instanceof Paragraph
                && first.getNext() == null
                && item.getParent() instanceof ListBlock list
                && list.isTight();
        if (tightParagraph) {
            appendInlineChildren(li, first);
        } else {
            appendBlockChildren(li, item);
        }
        parent.child(li);
    }

    private static void appendTable(HtmlNode target, TableBlock table) {
        HtmlNode element = new HtmlNode("table").attr("class", "jhin-table");
        for (Node part = table.getFirstChild(); part != null; part = part.getNext()) {
            switch (part) {
                case TableHead head -> {
                    HtmlNode thead = new HtmlNode("thead");
                    appendTableRows(thead, head);
                    element.child(thead);
                }
                case TableBody body -> {
                    HtmlNode tbody = new HtmlNode("tbody");
                    appendTableRows(tbody, body);
                    element.child(tbody);
                }
                case TableRow row -> appendTableRows(element, row);
                default -> {
                    // unknown table part: dropped, never thrown
                }
            }
        }
        target.child(element);
    }

    private static void appendTableRows(HtmlNode target, Node rows) {
        for (Node child = rows.getFirstChild(); child != null; child = child.getNext()) {
            if (child instanceof TableRow row) {
                HtmlNode tr = new HtmlNode("tr");
                for (Node cellNode = row.getFirstChild(); cellNode != null;
                        cellNode = cellNode.getNext()) {
                    if (cellNode instanceof TableCell cell) {
                        tr.child(tableCell(cell));
                    }
                }
                target.child(tr);
            }
        }
    }

    private static HtmlNode tableCell(TableCell cell) {
        HtmlNode element = new HtmlNode(cell.isHeader() ? "th" : "td");
        if (cell.getAlignment() != null) {
            element.attr("style", "text-align: "
                    + cell.getAlignment().name().toLowerCase(java.util.Locale.ROOT));
        }
        appendInlineChildren(element, cell);
        return element;
    }

    // --- inlines ----------------------------------------------------------

    /** Appends {@code node}'s inline content wrapped in {@code <tag>}. */
    private static void appendWrapped(HtmlNode target, String tag, Node node) {
        HtmlNode element = new HtmlNode(tag);
        appendInlineChildren(element, node);
        target.child(element);
    }

    private static void appendInlineChildren(HtmlNode target, Node parent) {
        for (Node child = parent.getFirstChild(); child != null; child = child.getNext()) {
            appendInline(target, child);
        }
    }

    private static void appendInline(HtmlNode target, Node node) {
        switch (node) {
            case Text text -> target.textChild(text.getLiteral());
            case Code code -> target.child(
                    new HtmlNode("code").attr("class", "jhin-code-inline")
                            .textChild(code.getLiteral()));
            case Emphasis ignored -> appendWrapped(target, "em", node);
            case StrongEmphasis ignored -> appendWrapped(target, "strong", node);
            case SoftLineBreak ignored -> target.textChild("\n");
            case HardLineBreak ignored -> target.child(new HtmlNode("br"));
            case Link link -> appendLink(target, link);
            case Image image -> appendImage(target, image);
            case HtmlInline htmlInline -> {
                // Belt and suspenders: inline HTML is never markup here.
                target.textChild(htmlInline.getLiteral());
            }
            default -> appendInlineChildren(target, node);
        }
    }

    private static void appendLink(HtmlNode target, Link link) {
        String href = safeWebUrl(link.getDestination());
        if (href == null) {
            // Unsafe scheme: the text survives, the click target does not.
            appendInlineChildren(target, link);
            return;
        }
        HtmlNode element = new HtmlNode("a").attr("class", "jhin-link")
                .attr("href", href);
        if (link.getTitle() != null) {
            element.attr("title", link.getTitle());
        }
        appendInlineChildren(element, link);
        target.child(element);
    }

    private static void appendImage(HtmlNode target, Image image) {
        String src = safeImageUrl(image.getDestination());
        HtmlNode element = new HtmlNode("img").attr("class", "jhin-image");
        element.attr("src", src == null ? "" : src);
        element.attr("alt", plainText(image));
        if (image.getTitle() != null) {
            element.attr("title", image.getTitle());
        }
        target.child(element);
    }

    /** The concatenated {@code Text} literals of an inline subtree. */
    private static String plainText(Node node) {
        StringBuilder out = new StringBuilder();
        collectText(node, out);
        return out.toString();
    }

    private static void collectText(Node node, StringBuilder out) {
        for (Node child = node.getFirstChild(); child != null; child = child.getNext()) {
            if (child instanceof Text text) {
                out.append(text.getLiteral());
            } else {
                collectText(child, out);
            }
        }
    }

    // --- URL allow-lists --------------------------------------------------

    /**
     * A safe {@code href}: {@code http}, {@code https}, {@code mailto} and
     * scheme-less (relative, {@code #anchor}) references pass; every other
     * scheme ({@code javascript:}, {@code data:}, {@code vbscript:}, …)
     * returns {@code null} and degrades to plain text.
     */
    static String safeWebUrl(String destination) {
        if (destination == null) {
            return null;
        }
        String trimmed = destination.strip();
        java.util.regex.Matcher matcher = SCHEME.matcher(trimmed);
        if (!matcher.find()) {
            return trimmed.isEmpty() ? null : trimmed;
        }
        String scheme = matcher.group(1).toLowerCase(java.util.Locale.ROOT);
        if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme)) {
            return trimmed;
        }
        return null;
    }

    /** A safe {@code src}: the web allow-list plus {@code data:image/…;base64}. */
    static String safeImageUrl(String destination) {
        if (destination == null) {
            return null;
        }
        String trimmed = destination.strip();
        if (DATA_IMAGE.matcher(trimmed).find()) {
            return trimmed;
        }
        return safeWebUrl(trimmed);
    }

    /** The info string of a fenced block as a {@code language-…} token, or null. */
    private static String languageOf(String info) {
        if (info == null) {
            return null;
        }
        String token = info.strip().split("\\s+", 2)[0];
        return LANGUAGE.matcher(token).matches() ? token : null;
    }
}
