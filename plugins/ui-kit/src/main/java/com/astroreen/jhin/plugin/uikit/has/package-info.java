/**
 * The {@code Has*} builder lattice: one interface per universal prop group of
 * the SDUI contract (docs/sdui.md section 2.1). Each interface declares the
 * typed setters of exactly one group; the wire key of every setter equals its
 * method name, so a builder key can never drift from the documented prop
 * name. Primitive builders compose the interfaces they support and the
 * {@code com.astroreen.jhin.plugin.uikit.Ui.NodeBuilder} base implements the
 * universal four (Box, Text, Flex, Interaction) once for every builder.
 *
 * <p>Every setter stores the value under its wire key and returns the builder
 * for chaining. Enum-typed props validate the literal immediately and throw
 * {@link IllegalArgumentException} on an unknown value — a builder bug is a
 * build-time failure, never a silent render-time degradation. Unset params
 * are simply absent from the emitted JSON.
 */
package com.astroreen.jhin.plugin.uikit.has;
