/**
 * Resolves the {@code requires} edges between plugin manifests into a stable
 * load order plus a failure list.
 *
 * <p>A plugin fails when one of its non-optional requirements is missing or
 * falls outside the declared version range, when it sits on a dependency
 * cycle, or when a non-optional dependency of its own failed (cascade). Every
 * failure carries a human-readable reason. Optional requirements never fail
 * their dependant: when the target is missing or failed the edge is simply
 * dropped. Surviving plugins come back in topological order, with ties broken
 * by plugin id, so a fixed input always yields the same order.
 */
package com.astroreen.jhin.kernel.loader;

import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.VersionRange;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.Set;

public final class DependencyGraph {

    private DependencyGraph() {
    }

    /**
     * One plugin taking part in resolution. Wraps its validated manifest;
     * plugin ids are expected to be unique across the input.
     *
     * @param manifest the validated manifest of the plugin
     */
    public record Node(PluginManifest manifest) {

        /**
         * @return the plugin id
         */
        public String id() {
            return manifest.id();
        }

        /**
         * @return the plugin version in {@code major.minor.patch} form
         */
        public String version() {
            return manifest.version();
        }

        /**
         * @return the declared requirements; never {@code null}
         */
        public List<PluginManifest.Requirement> requires() {
            return manifest.requires() == null ? List.of() : manifest.requires();
        }
    }

    /**
     * One plugin that cannot be loaded.
     *
     * @param id     the plugin id
     * @param reason why the plugin was rejected
     */
    public record Failure(String id, String reason) {}

    /**
     * The outcome of resolution.
     *
     * @param ordered the loadable plugins in topological order
     * @param failed  the rejected plugins, sorted by id
     */
    public record Result(List<Node> ordered, List<Failure> failed) {}

    /**
     * Resolves the requirements of the given plugins.
     *
     * @param nodes the candidate plugins, in any order
     * @return the load order and the failures, see {@link Result}
     */
    public static Result resolve(List<Node> nodes) {
        Map<String, Node> byId = new LinkedHashMap<>();
        for (Node node : nodes) {
            Objects.requireNonNull(node, "node");
            byId.put(node.id(), node);
        }

        Map<String, String> reasons = new LinkedHashMap<>();
        failOnBrokenRequirements(nodes, byId, reasons);
        failOnCycles(nodes, byId, reasons);
        failOnFailedDependencies(nodes, byId, reasons);

        List<Node> ordered = sortByDependencies(nodes, byId, reasons.keySet());
        List<Failure> failed = reasons.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> new Failure(entry.getKey(), entry.getValue()))
                .toList();
        return new Result(List.copyOf(ordered), failed);
    }

    private static void failOnBrokenRequirements(
            List<Node> nodes, Map<String, Node> byId, Map<String, String> reasons) {
        for (Node node : nodes) {
            for (PluginManifest.Requirement requirement : node.requires()) {
                if (requirement.optional()) {
                    continue;
                }
                VersionRange range = VersionRange.parse(requirement.versionRange());
                Node target = byId.get(requirement.id());
                if (target == null) {
                    reasons.put(node.id(), "plugin " + node.id() + " requires " + requirement.id()
                            + " " + requirement.versionRange() + ", found none");
                    break;
                }
                if (!range.satisfies(target.version())) {
                    reasons.put(node.id(), "plugin " + node.id() + " requires " + requirement.id()
                            + " " + requirement.versionRange() + ", found " + target.version());
                    break;
                }
            }
        }
    }

    private static void failOnCycles(
            List<Node> nodes, Map<String, Node> byId, Map<String, String> reasons) {
        List<Node> active = nodes.stream()
                .filter(node -> !reasons.containsKey(node.id()))
                .sorted(Comparator.comparing(Node::id))
                .toList();
        while (true) {
            List<String> cycle = findCycle(active, byId, reasons.keySet());
            if (cycle == null) {
                return;
            }
            String reason = "dependency cycle: " + String.join(" -> ", cycle);
            for (String id : cycle) {
                reasons.putIfAbsent(id, reason);
            }
            active = active.stream()
                    .filter(node -> !reasons.containsKey(node.id()))
                    .toList();
        }
    }

    /**
     * Finds one dependency cycle among the active plugins as the closed path
     * {@code a -> b -> a}, or {@code null} when the active subgraph is
     * acyclic. Roots and requirements are visited in plugin-id order, so the
     * reported path is deterministic.
     */
    private static List<String> findCycle(
            List<Node> active, Map<String, Node> byId, Set<String> failedIds) {
        Set<String> settled = new HashSet<>();
        Set<String> onPath = new HashSet<>();
        List<String> path = new ArrayList<>();
        for (Node root : active) {
            List<String> cycle = explore(root, byId, failedIds, settled, onPath, path);
            if (cycle != null) {
                return cycle;
            }
        }
        return null;
    }

    private static List<String> explore(
            Node node,
            Map<String, Node> byId,
            Set<String> failedIds,
            Set<String> settled,
            Set<String> onPath,
            List<String> path) {
        if (settled.contains(node.id())) {
            return null;
        }
        if (onPath.contains(node.id())) {
            List<String> cycle = new ArrayList<>(path.subList(path.indexOf(node.id()), path.size()));
            cycle.add(node.id());
            return cycle;
        }
        onPath.add(node.id());
        path.add(node.id());
        for (Node dependency : liveDependencies(node, byId, failedIds)) {
            List<String> cycle = explore(dependency, byId, failedIds, settled, onPath, path);
            if (cycle != null) {
                return cycle;
            }
        }
        path.remove(path.size() - 1);
        onPath.remove(node.id());
        settled.add(node.id());
        return null;
    }

    private static void failOnFailedDependencies(
            List<Node> nodes, Map<String, Node> byId, Map<String, String> reasons) {
        boolean changed = true;
        while (changed) {
            changed = false;
            for (Node node : nodes) {
                if (reasons.containsKey(node.id())) {
                    continue;
                }
                for (PluginManifest.Requirement requirement : node.requires()) {
                    if (requirement.optional()) {
                        continue;
                    }
                    Node target = byId.get(requirement.id());
                    if (target != null && reasons.containsKey(target.id())) {
                        reasons.put(node.id(), "dependency " + requirement.id() + " failed");
                        changed = true;
                        break;
                    }
                }
            }
        }
    }

    private static List<Node> sortByDependencies(
            List<Node> nodes, Map<String, Node> byId, Set<String> failedIds) {
        List<Node> alive = nodes.stream()
                .filter(node -> !failedIds.contains(node.id()))
                .toList();
        Map<String, Integer> unmet = new HashMap<>();
        Map<String, List<Node>> dependants = new HashMap<>();
        for (Node node : alive) {
            unmet.putIfAbsent(node.id(), 0);
            for (Node dependency : liveDependencies(node, byId, failedIds)) {
                unmet.merge(node.id(), 1, Integer::sum);
                dependants.computeIfAbsent(dependency.id(), key -> new ArrayList<>()).add(node);
            }
        }
        PriorityQueue<Node> ready = new PriorityQueue<>(Comparator.comparing(Node::id));
        for (Node node : alive) {
            if (unmet.get(node.id()) == 0) {
                ready.add(node);
            }
        }
        List<Node> ordered = new ArrayList<>();
        while (!ready.isEmpty()) {
            Node node = ready.poll();
            ordered.add(node);
            for (Node dependant : dependants.getOrDefault(node.id(), List.of())) {
                if (unmet.merge(dependant.id(), -1, Integer::sum) == 0) {
                    ready.add(dependant);
                }
            }
        }
        if (ordered.size() != alive.size()) {
            throw new IllegalStateException("dependency resolution left an undetected cycle");
        }
        return ordered;
    }

    private static List<Node> liveDependencies(
            Node node, Map<String, Node> byId, Set<String> failedIds) {
        return node.requires().stream()
                .map(requirement -> byId.get(requirement.id()))
                .filter(Objects::nonNull)
                .filter(dependency -> !failedIds.contains(dependency.id()))
                .sorted(Comparator.comparing(Node::id))
                .toList();
    }
}