package com.astroreen.jhin.core.tools.gitignore;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GitIgnoreTest {

    @Test
    void logPatternMatchesAtAnyDepth() {
        GitIgnore ignore = GitIgnore.parse("*.log");

        assertThat(ignore.isIgnored("a.log", false)).isTrue();
        assertThat(ignore.isIgnored("x/y/z.log", false)).isTrue();
        assertThat(ignore.isIgnored("a.txt", false)).isFalse();
    }

    @Test
    void directoryPatternMatchesDirAndEverythingUnder() {
        GitIgnore ignore = GitIgnore.parse("build/");

        assertThat(ignore.isIgnored("build", true)).isTrue();
        assertThat(ignore.isIgnored("build/x/y", false)).isTrue();
        assertThat(ignore.isIgnored("build/x/y", true)).isTrue();
    }

    @Test
    void directoryPatternDoesNotMatchPlainFile() {
        GitIgnore ignore = GitIgnore.parse("build/");

        assertThat(ignore.isIgnored("build", false)).isFalse();
    }

    @Test
    void leadingSlashAnchorsToRoot() {
        GitIgnore ignore = GitIgnore.parse("/root.txt");

        assertThat(ignore.isIgnored("root.txt", false)).isTrue();
        assertThat(ignore.isIgnored("sub/root.txt", false)).isFalse();
    }

    @Test
    void embeddedSlashAnchorsToRoot() {
        GitIgnore ignore = GitIgnore.parse("sub/root.txt");

        assertThat(ignore.isIgnored("sub/root.txt", false)).isTrue();
        assertThat(ignore.isIgnored("root.txt", false)).isFalse();
        assertThat(ignore.isIgnored("sub/sub/root.txt", false)).isFalse();
    }

    @Test
    void doubleStarPrefixMatchesAtAnyDepth() {
        GitIgnore ignore = GitIgnore.parse("**/foo");

        assertThat(ignore.isIgnored("foo", false)).isTrue();
        assertThat(ignore.isIgnored("a/foo", false)).isTrue();
        assertThat(ignore.isIgnored("a/b/foo", false)).isTrue();
        assertThat(ignore.isIgnored("a/foobar", false)).isFalse();
    }

    @Test
    void questionMarkMatchesSingleChar() {
        GitIgnore ignore = GitIgnore.parse("a?c");

        assertThat(ignore.isIgnored("abc", false)).isTrue();
        assertThat(ignore.isIgnored("a-c", false)).isTrue();
        assertThat(ignore.isIgnored("ac", false)).isFalse();
    }

    @Test
    void charClassMatchesSet() {
        GitIgnore ignore = GitIgnore.parse("[abc].txt");

        assertThat(ignore.isIgnored("a.txt", false)).isTrue();
        assertThat(ignore.isIgnored("d.txt", false)).isFalse();
    }

    @Test
    void charClassRangesAndNegation() {
        GitIgnore range = GitIgnore.parse("[a-c].txt");
        assertThat(range.isIgnored("b.txt", false)).isTrue();
        assertThat(range.isIgnored("d.txt", false)).isFalse();

        GitIgnore negated = GitIgnore.parse("[!a-c].txt");
        assertThat(negated.isIgnored("d.txt", false)).isTrue();
        assertThat(negated.isIgnored("b.txt", false)).isFalse();
    }

    @Test
    void lastMatchingPatternWinsNegation() {
        GitIgnore ignore = GitIgnore.parse("*.log\n!important.log");

        assertThat(ignore.isIgnored("important.log", false)).isFalse();
        assertThat(ignore.isIgnored("other.log", false)).isTrue();
    }

    @Test
    void lastMatchingPatternWinsIgnoreAfterNegation() {
        GitIgnore ignore = GitIgnore.parse("!important.log\n*.log");

        assertThat(ignore.isIgnored("important.log", false)).isTrue();
    }

    @Test
    void commentsAndBlankLinesSkipped() {
        GitIgnore ignore = GitIgnore.parse("# just a comment\n\n   \n*.log");

        assertThat(ignore.isIgnored("a.log", false)).isTrue();
        assertThat(GitIgnore.parse("#foo.log").isIgnored("foo.log", false)).isFalse();
        assertThat(GitIgnore.parse("").isIgnored("anything", false)).isFalse();
    }

    @Test
    void doubleStarInsidePatternMatchesZeroOrMoreDirs() {
        GitIgnore ignore = GitIgnore.parse("a/**/b");

        assertThat(ignore.isIgnored("a/b", false)).isTrue();
        assertThat(ignore.isIgnored("a/x/b", false)).isTrue();
        assertThat(ignore.isIgnored("a/x/y/b", false)).isTrue();
        assertThat(ignore.isIgnored("a/c", false)).isFalse();
    }

    @Test
    void trailingDoubleStarMatchesEverythingInside() {
        GitIgnore ignore = GitIgnore.parse("a/**");

        assertThat(ignore.isIgnored("a/x", false)).isTrue();
        assertThat(ignore.isIgnored("a/x/y", false)).isTrue();
        assertThat(ignore.isIgnored("a", true)).isFalse();
    }

    @Test
    void escapesMakeLiterals() {
        assertThat(GitIgnore.parse("\\#foo").isIgnored("#foo", false)).isTrue();
        assertThat(GitIgnore.parse("\\#foo").isIgnored("foo", false)).isFalse();
        assertThat(GitIgnore.parse("\\!bang").isIgnored("!bang", false)).isTrue();
    }

    @Test
    void ignoredDirectoryCannotReIncludeChildren() {
        GitIgnore ignore = GitIgnore.parse("build/\n!build/x.txt");

        assertThat(ignore.isIgnored("build/x.txt", false)).isTrue();
    }

    @Test
    void normalizesLeadingDotSlash() {
        GitIgnore ignore = GitIgnore.parse("*.log");

        assertThat(ignore.isIgnored("./a.log", false)).isTrue();
    }

    @Test
    void loadMissingFileYieldsEmptyMatcher(@TempDir Path workdir) throws IOException {
        GitIgnore ignore = GitIgnore.load(workdir);

        assertThat(ignore.isIgnored("a.log", false)).isFalse();
        assertThat(ignore.isIgnored("build", true)).isFalse();
    }

    @Test
    void loadReadsRootGitignore(@TempDir Path workdir) throws IOException {
        Files.writeString(workdir.resolve(".gitignore"), "*.log\nbuild/\n");

        GitIgnore ignore = GitIgnore.load(workdir);

        assertThat(ignore.isIgnored("a.log", false)).isTrue();
        assertThat(ignore.isIgnored("build", true)).isTrue();
        assertThat(ignore.isIgnored("keep.java", false)).isFalse();
    }
}
