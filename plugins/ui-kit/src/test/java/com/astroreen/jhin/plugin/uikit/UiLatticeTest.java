/**
 * One dynamic test per {@code Has*} lattice method: the setter lands its
 * exact wire key in the emitted JSON. The wire key of a setter is its method
 * name, except the children/items appenders which fill the {@code children}
 * array and the {@code items} prop.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.has.HasBox;
import com.astroreen.jhin.plugin.uikit.has.HasChildren;
import com.astroreen.jhin.plugin.uikit.has.HasDiffView;
import com.astroreen.jhin.plugin.uikit.has.HasFlex;
import com.astroreen.jhin.plugin.uikit.has.HasGlass;
import com.astroreen.jhin.plugin.uikit.has.HasHoverCard;
import com.astroreen.jhin.plugin.uikit.has.HasInteraction;
import com.astroreen.jhin.plugin.uikit.has.HasItems;
import com.astroreen.jhin.plugin.uikit.has.HasKbd;
import com.astroreen.jhin.plugin.uikit.has.HasSplit;
import com.astroreen.jhin.plugin.uikit.has.HasText;
import com.astroreen.jhin.plugin.uikit.has.HasToastStack;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicContainer;
import org.junit.jupiter.api.DynamicNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

class UiLatticeTest {

    private record Group(Class<?> iface, Supplier<Object> builder) {
    }

    @TestFactory
    Stream<DynamicNode> everyLatticeMethodLandsItsWireKey() {
        List<Group> groups = List.of(
                new Group(HasBox.class, Ui::container),
                new Group(HasText.class, () -> Ui.text("probe")),
                new Group(HasFlex.class, Ui::container),
                new Group(HasInteraction.class, Ui::container),
                new Group(HasChildren.class, Ui::card),
                new Group(HasItems.class, Ui::list),
                new Group(HasGlass.class, Ui::card),
                new Group(HasSplit.class, Ui::split),
                new Group(HasHoverCard.class, Ui::hoverCard),
                new Group(HasKbd.class, Ui::kbd),
                new Group(HasToastStack.class, Ui::toastStack),
                new Group(HasDiffView.class, Ui::diffView));

        return groups.stream().map(group -> {
            List<DynamicTest> tests = new ArrayList<>();
            for (Method method : group.iface().getMethods()) {
                if (method.isBridge() || method.isSynthetic()
                        || method.getParameterCount() != 1
                        || method.getReturnType() == void.class
                        || method.getDeclaringClass() == Object.class) {
                    continue;
                }
                tests.add(DynamicTest.dynamicTest(
                        method.getName() + " -> " + BuilderProbe.wireKey(method),
                        () -> assertWireKey(group, method)));
            }
            return DynamicContainer.dynamicContainer(group.iface().getSimpleName(), tests);
        });
    }

    private void assertWireKey(Group group, Method method) {
        Object builder = group.builder().get();
        // The diff_view demo marker is mandatory at build() — satisfy it up
        // front so the single-method probes reach the wire-shape assert.
        if (builder instanceof Ui.DiffViewBuilder diffView) {
            diffView.demo(true);
        }
        // children(List) must carry an entry or the array stays absent from the wire
        Object value = method.getName().equals("children")
                ? List.of("probe") : BuilderProbe.valueFor(builder.getClass(), method, method.getParameterTypes()[0]);
        try {
            method.invoke(builder, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("lattice test failed to invoke " + method.getName(), e);
        }
        UiNode node = ((Ui.NodeBuilder<?>) builder).build();
        Map<String, Object> json = node.toJson();
        assertThat(json).as("wire key of %s#%s", group.iface().getSimpleName(), method.getName())
                .containsKey(BuilderProbe.wireKey(method));
    }

    private interface Supplier<T> {
        T get();
    }
}
