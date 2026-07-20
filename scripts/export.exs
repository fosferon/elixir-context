#!/usr/bin/env elixir

# Elixir Context Exporter v2
# Scans Elixir files and outputs JSONL with function/module/macro metadata

Application.ensure_all_started(:logger)
Logger.configure(level: :warning)
Logger.configure_backend(:console, level: :warning)

# Ensure Jason is available (needed for JSON encoding)
unless Code.ensure_loaded?(Jason) and function_exported?(Jason, :encode!, 1) do
  Mix.install([:jason])
end

try do
  if Code.ensure_loaded?(Mix) do
    Mix.shell(Mix.Shell.Quiet)
  end
rescue
  _ -> :ok
end

defmodule Exporter do
  # Macro calls we want to index as searchable entries
  @indexed_macros ~w(defevent field belongs_to has_many has_one embeds_one embeds_many
                     many_to_many timestamps plug pipe_through live get post put patch delete
                     forward socket channel)a

  def main(args) do
    {opts, rest, _} = OptionParser.parse(args, switches: [file: :string, files: :boolean, quiet: :boolean, out: :string])
    quiet = opts[:quiet] || false
    out_path = opts[:out]

    files =
      cond do
        # --files flag: remaining args are file paths (for incremental rebuild)
        opts[:files] ->
          rest
          |> Enum.filter(&(String.ends_with?(&1, ".ex") or String.ends_with?(&1, ".exs")))
          |> Enum.filter(&File.exists?/1)

        # Legacy --file flag: single file
        opts[:file] ->
          [opts[:file]]

        # Full scan
        true ->
          project_patterns = [
            "apps/**/*.{ex,exs}",
            "lib/**/*.{ex,exs}",
            "test/**/*.{ex,exs}",
            "config/**/*.{ex,exs}",
            "priv/**/*.{ex,exs}",
            "*.{ex,exs}"
          ]

          project_patterns
          |> Enum.flat_map(&Path.wildcard/1)
          |> Enum.reject(fn file ->
            String.starts_with?(file, "deps/") or
            String.starts_with?(file, "_build/") or
            String.contains?(file, "/deps/") or
            String.contains?(file, "/_build/") or
            String.contains?(file, "/node_modules/") or
            String.contains?(file, ".git/") or
            String.contains?(file, "/templates/") or
            String.contains?(file, "/.worktrees/")
          end)
      end

    {processed, skipped, all_defs} = Enum.reduce(files, {0, 0, []}, fn file, {proc, skip, defs_acc} ->
      case File.read(file) do
        {:ok, content} ->
          case Code.string_to_quoted(content, columns: true, line: 1) do
            {:ok, ast} ->
              try do
                defs = extract_definitions(ast, file)
                {proc + 1, skip, defs_acc ++ defs}
              catch
                kind, reason ->
                  unless quiet, do: IO.puts(:stderr, "Extract error in #{file}: #{inspect({kind, reason})}")
                  {proc, skip + 1, defs_acc}
              end

            {:error, reason} ->
              unless quiet, do: IO.puts(:stderr, "Parse error in #{file}: #{inspect(reason)}")
              {proc, skip + 1, defs_acc}
          end

        {:error, reason} ->
          unless quiet, do: IO.puts(:stderr, "Read error for #{file}: #{reason}")
          {proc, skip + 1, defs_acc}
      end
    end)

    # Deduplicate: merge multi-clause functions (union calls, keep earliest line,
    # and ENUMERATE every clause instead of collapsing to the first).
    unique_defs =
      all_defs
      |> Enum.group_by(fn def -> {def.module, def.name, def.arity, def.kind} end)
      |> Enum.map(fn {_key, defs} ->
        sorted = Enum.sort_by(defs, & &1.start_line)
        primary = hd(sorted)
        last = Enum.max_by(defs, & &1.end_line)
        merged_calls = defs |> Enum.flat_map(& &1.calls) |> Enum.uniq_by(fn s -> {s.callee, s.line} end)

        # Build a clause manifest (ordinal, signature, line range) for every
        # clause. Only def-kinds have real clauses; module/use/schema/macro_call
        # entries are single conceptual units and get no clause list.
        def_kinds = ~w(function function_private macro macro_private)
        base = %{primary | calls: merged_calls, end_line: last.end_line}

        if primary.kind in def_kinds do
          clauses =
            sorted
            |> Enum.with_index(1)
            |> Enum.map(fn {d, ordinal} ->
              %{
                ordinal: ordinal,
                signature: d.signature,
                start_line: d.start_line,
                end_line: d.end_line || d.start_line,
                head_patterns: d.head_patterns,
                guarded: d.guarded
              }
            end)
          Map.put(base, :clauses, clauses)
        else
          base
        end
      end)

    # Build the clause index from merged functions, then attribute every call
    # site to the clause(s) it could resolve to. head_patterns/guarded ride on
    # each clause for this pass and are stripped before emit so the JSONL only
    # carries the user-visible clause manifest.
    clause_index =
      Enum.reduce(unique_defs, %{}, fn d, acc ->
        key = {d.module, d.name, d.arity}
        Enum.reduce(Map.get(d, :clauses) || [], acc, fn c, acc2 ->
          entry = {c.ordinal, c.head_patterns, c.guarded}
          Map.update(acc2, key, [entry], fn existing -> existing ++ [entry] end)
        end)
      end)

    unique_defs =
      Enum.map(unique_defs, fn d ->
        attributed = Enum.map(d.calls, &attribute_call(&1, clause_index))
        d_clauses = Map.get(d, :clauses)
        clean_clauses = Enum.map(d_clauses || [], &Map.drop(&1, [:head_patterns, :guarded]))
        d2 = %{d | calls: attributed}
        if d_clauses, do: %{d2 | clauses: clean_clauses}, else: d2
      end)

    if out_path do
      {:ok, io} = File.open(out_path, [:write, :binary])
      Enum.each(unique_defs, fn defn -> IO.binwrite(io, Jason.encode!(defn) <> "\n") end)
      File.close(io)
    else
      Enum.each(unique_defs, &IO.puts(Jason.encode!(&1)))
    end

    unless quiet do
      total = length(files)
      kinds = Enum.frequencies_by(unique_defs, & &1.kind)
      IO.puts(:stderr, "Files: #{total} (#{processed} ok, #{skipped} skipped)")
      IO.puts(:stderr, "Entries: #{length(unique_defs)} — #{inspect(kinds)}")
    end

    if skipped > 0 do
      System.halt(1)
    end
  end

  def extract_definitions(ast, file) do
    Macro.prewalk(ast, [], fn
      {:defmodule, meta, [module, [do: body]]}, acc ->
        module_name = module_to_string(module)
        module_line = meta[:line] || 1
        {defs, module_meta} = extract_from_module(body, module_name, file, module_line)
        module_entry = build_module_entry(module_name, file, module_line, meta, module_meta)
        {body, [module_entry | defs] ++ acc}

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
  end

  def extract_from_module(body, module_name, file, module_line) do
    # Walk the module body collecting functions, macros, and module-level metadata
    {_, {defs, _attrs, module_meta}} =
      safe_prewalk_with_state(body, {[], %{}, %{uses: [], behaviours: [], moduledoc: nil}}, fn

        # @moduledoc
        {:@, _, [{:moduledoc, _, [doc_string]}]} = node, {defs, attrs, meta} ->
          {node, {defs, attrs, %{meta | moduledoc: flatten_doc_ast(doc_string)}}}

        # @behaviour
        {:@, _, [{:behaviour, _, [behaviour_mod]}]} = node, {defs, attrs, meta} ->
          behaviour_name = module_to_string(behaviour_mod)
          {node, {defs, attrs, %{meta | behaviours: [behaviour_name | meta.behaviours]}}}

        # use SomeModule
        {:use, meta_u, [used_mod | _rest]} = node, {defs, attrs, meta} ->
          used_name = module_to_string(used_mod)
          use_entry = %{
            id: make_id(module_name, "use_#{used_name}", 0, file),
            module: module_name,
            name: "use #{used_name}",
            arity: 0,
            kind: "use",
            path: file,
            start_line: meta_u[:line] || module_line,
            end_line: meta_u[:line] || module_line,
            signature: "use #{used_name}",
            spec: nil,
            doc: nil,
            lexical_text: "#{module_name} use #{used_name}",
            struct_text: Macro.to_string(node),
            calls: []
          }
          {node, {[use_entry | defs], attrs, %{meta | uses: [used_name | meta.uses]}}}

        # @doc
        {:@, _, [{:doc, _, [doc_string]}]} = node, {defs, attrs, meta} ->
          {node, {defs, Map.put(attrs, :pending_doc, flatten_doc_ast(doc_string)), meta}}

        # @spec
        {:@, _, [{:spec, _, spec_ast}]} = node, {defs, attrs, meta} ->
          spec_text = Macro.to_string({:spec, [], spec_ast})
          {node, {defs, Map.put(attrs, :pending_spec, spec_text), meta}}

        # def / defp / defmacro — with guards (AST wraps head in {:when, _, [head, guard]})
        {:def, meta_d, [{:when, _, [{name, _, args}, _guard]}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "function", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defp, meta_d, [{:when, _, [{name, _, args}, _guard]}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "function_private", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defmacro, meta_d, [{:when, _, [{name, _, args}, _guard]}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "macro", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defmacrop, meta_d, [{:when, _, [{name, _, args}, _guard]}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "macro_private", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        # def / defp / defmacro — without guards (simple form)
        {:def, meta_d, [{name, _, args}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "function", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defp, meta_d, [{name, _, args}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "function_private", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defmacro, meta_d, [{name, _, args}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "macro", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        {:defmacrop, meta_d, [{name, _, args}, body_list]} = node, {defs, attrs, meta} when is_atom(name) ->
          def_info = extract_def_info(node, meta_d, name, args || [], module_name, file, "macro_private", attrs, body_list)
          {node, {[def_info | defs], %{}, meta}}

        # Indexed macro calls (defevent, field, belongs_to, plug, etc.)
        {macro_name, meta_m, macro_args} = node, {defs, attrs, meta}
            when is_atom(macro_name) and macro_name in unquote(@indexed_macros) and is_list(macro_args) ->
          macro_entry = extract_macro_call(node, meta_m, macro_name, macro_args, module_name, file)
          {node, {[macro_entry | defs], attrs, meta}}

        # Ecto schema block: schema "table_name" do ... end
        {:schema, meta_s, [table_name | _]} = node, {defs, attrs, meta} when is_binary(table_name) ->
          schema_entry = %{
            id: make_id(module_name, "schema", 0, file),
            module: module_name,
            name: "schema",
            arity: 0,
            kind: "schema",
            path: file,
            start_line: meta_s[:line] || module_line,
            end_line: meta_s[:end_line] || meta_s[:line] || module_line,
            signature: "schema \"#{table_name}\"",
            spec: nil,
            doc: nil,
            lexical_text: "#{module_name} schema #{table_name} ecto",
            struct_text: "schema \"#{table_name}\"",
            calls: []
          }
          {node, {[schema_entry | defs], attrs, meta}}

        node, acc ->
          {node, acc}
      end)

    {defs, module_meta}
  end

  defp build_module_entry(module_name, file, module_line, meta, module_meta) do
    uses_text = Enum.join(module_meta.uses, " ")
    behaviours_text = Enum.join(module_meta.behaviours, " ")
    doc_text = if module_meta.moduledoc, do: String.slice(module_meta.moduledoc, 0, 200), else: ""

    lexical_text =
      [module_name, uses_text, behaviours_text, doc_text]
      |> Enum.reject(&(&1 == "" or is_nil(&1)))
      |> Enum.join(" ")

    %{
      id: make_id(module_name, "defmodule", 0, file),
      module: module_name,
      name: "defmodule",
      arity: 0,
      kind: "module",
      path: file,
      start_line: module_line,
      end_line: meta[:end_line] || module_line,
      signature: "defmodule #{module_name}",
      spec: nil,
      doc: doc_text,
      lexical_text: lexical_text,
      struct_text: "defmodule #{module_name}",
      calls: []
    }
  end

  defp extract_macro_call(_node, meta, macro_name, macro_args, module_name, file) do
    # Build a readable signature from the macro arguments
    first_arg = List.first(macro_args)
    label = cond do
      is_atom(first_arg) -> "#{macro_name} :#{first_arg}"
      is_binary(first_arg) -> "#{macro_name} \"#{first_arg}\""
      true -> "#{macro_name} #{Macro.to_string(first_arg || "")}"
    end

    # For defevent, extract from/to for richer search
    extra_keywords = extract_macro_keywords(macro_name, macro_args)

    %{
      id: make_id(module_name, "#{macro_name}_#{label}", 0, file),
      module: module_name,
      name: to_string(macro_name),
      arity: length(macro_args),
      kind: "macro_call",
      path: file,
      start_line: meta[:line] || 1,
      end_line: meta[:end_line] || meta[:line] || 1,
      signature: label,
      spec: nil,
      doc: nil,
      lexical_text: "#{module_name} #{label} #{extra_keywords}",
      struct_text: label,
      calls: []
    }
  end

  defp extract_macro_keywords(:defevent, [event_name | rest]) do
    # Extract from:/to: options from defevent
    opts = List.last(rest) || []
    from = if is_list(opts), do: Keyword.get(opts, :from, ""), else: ""
    to = if is_list(opts), do: Keyword.get(opts, :to, ""), else: ""
    "defevent #{Macro.to_string(event_name)} from #{Macro.to_string(from)} to #{Macro.to_string(to)} workflow fsm state_machine"
  end

  defp extract_macro_keywords(:field, [field_name, type | _]) do
    "field #{Macro.to_string(field_name)} #{inspect(type)} schema ecto"
  end

  defp extract_macro_keywords(:belongs_to, [assoc_name | _]) do
    "belongs_to #{Macro.to_string(assoc_name)} association ecto"
  end

  defp extract_macro_keywords(:has_many, [assoc_name | _]) do
    "has_many #{Macro.to_string(assoc_name)} association ecto"
  end

  defp extract_macro_keywords(:has_one, [assoc_name | _]) do
    "has_one #{Macro.to_string(assoc_name)} association ecto"
  end

  defp extract_macro_keywords(:embeds_one, [assoc_name | _]) do
    "embeds_one #{Macro.to_string(assoc_name)} embedded ecto"
  end

  defp extract_macro_keywords(:embeds_many, [assoc_name | _]) do
    "embeds_many #{Macro.to_string(assoc_name)} embedded ecto"
  end

  defp extract_macro_keywords(:plug, [plug_name | _]) do
    "plug #{module_to_string(plug_name)} pipeline phoenix"
  end

  defp extract_macro_keywords(macro_name, _args), do: to_string(macro_name)

  # Flatten @doc / @moduledoc AST into a plain string.
  # Handles interpolation AST {:<<>>, _, parts} that appears when @doc
  # contains #{...} references to module attributes at compile time.
  def flatten_doc_ast(doc) when is_binary(doc), do: doc

  def flatten_doc_ast({:<<>>, _, parts}) do
    parts
    |> Enum.map(fn
      part when is_binary(part) -> part
      _ast_part -> "\#{...}"
    end)
    |> Enum.join()
  end

  def flatten_doc_ast({:sigil, _, [{:<<>>, _, parts} | _]}) do
    parts
    |> Enum.map(fn
      part when is_binary(part) -> part
      _ast_part -> "\#{...}"
    end)
    |> Enum.join()
  end

  def flatten_doc_ast(_other), do: nil

  def safe_prewalk_with_state(ast, acc, fun) do
    {ast, acc} = fun.(ast, acc)
    case ast do
      list when is_list(list) ->
        {list, acc} = Enum.map_reduce(list, acc, &safe_prewalk_with_state(&1, &2, fun))
        {list, acc}
      {name, meta, args} when is_list(args) ->
        {args, acc} = Enum.map_reduce(args, acc, &safe_prewalk_with_state(&1, &2, fun))
        {{name, meta, args}, acc}
      _ ->
        {ast, acc}
    end
  end

  def extract_def_info(node, meta, name, args, module_name, file, kind, attrs \\ %{}, body_list \\ nil) do
    args_list = if is_list(args), do: args, else: []
    arity = length(args_list)
    start_line = meta[:line] || 1
    end_line = meta[:end_line] || start_line

    signature = "#{name}(#{Enum.map_join(args_list, ", ", &Macro.to_string/1)})"
    spec = Map.get(attrs, :pending_spec)
    doc = Map.get(attrs, :pending_doc)

    # Whether this clause has a `when` guard. Guarded clauses can't be
    # definitively attributed to a call site (the guard may fail at runtime),
    # so the attribution pass treats a structural match against a guarded
    # clause as :unknown rather than :match.
    guarded = match?({_, _, [{:when, _, _} | _]}, node)

    # Normalized head patterns (one per arg) used by the clause-attribution
    # pass to unify against call-site argument patterns. See norm_pat/2.
    head_patterns = Enum.map(args_list, &norm_pat(&1, module_name))

    body_keywords = if body_list, do: extract_body_keywords(body_list, 30), else: []

    lexical_parts = [
      "#{module_name}.#{signature}",
      doc,
      spec,
      Enum.join(body_keywords, " ")
    ]
    lexical_text = lexical_parts |> Enum.reject(&is_nil/1) |> Enum.join(" ")

    struct_text = Macro.to_string(node)
    calls = extract_calls(node, module_name, name, arity)

    %{
      id: make_id(module_name, name, arity, file),
      module: module_name,
      name: to_string(name),
      arity: arity,
      kind: kind,
      path: file,
      start_line: start_line,
      end_line: end_line,
      signature: signature,
      spec: spec,
      doc: doc,
      lexical_text: lexical_text,
      struct_text: struct_text,
      calls: calls,
      head_patterns: head_patterns,
      guarded: guarded
    }
  end

  # Known Kernel/stdlib functions that are NOT local module calls
  # Control flow — these are special forms / macros, not real local calls
  # AST artifacts
  @kernel_functions MapSet.new(~w(
    send apply spawn spawn_link self
    elem tuple_size hd tl length map_size is_atom is_binary is_bitstring is_boolean
    is_float is_function is_integer is_list is_map is_number is_pid is_port is_reference
    is_tuple abs div rem max min round trunc byte_size bit_size
    raise throw exit put_elem put_in get_in update_in pop_in get_and_update_in
    inspect to_string IO.puts IO.inspect IO.warn
    is_nil is_exception not and or when
    build_options call_python
    case cond with if unless for while try catch rescue after receive
    do end fn def defp defmodule defmacro defmacrop defguard defstruct
    defprotocol defimpl require import alias use
    __aliases__ __block__ __MODULE__ __ENV__ __CALLER__ __DIR__
  )a)

  # Atom names that are operators / syntax — never real function names
  @skip_names MapSet.new(~w(
    -> ++ -- ** ::: .. ... <<>> {} [] %{} ^ @ & <|>
    != !== == === <= >= <> ~>> <<~ ~> <~ <~> =~
    || && &&& &&&& <<< >>> <<~ ~> <~> <|> ^^^ <<< >>>
    |> \\ :: in <-
  )a)

  def extract_calls(node, module_name \\ nil, self_name \\ nil, self_arity \\ nil) do
    # mfa of the enclosing def — used to drop self-edges. Every def's HEAD
    # matches the "bare local call" pattern below, so without this filter every
    # function would record itself as its own caller (and genuinely dead code
    # would show exactly one caller: itself). Genuine self-recursion is dropped
    # too, which is the correct semantics for caller/impact analysis.
    self_mfa =
      if module_name && self_name do
        "#{module_name}.#{self_name}/#{self_arity}"
      else
        nil
      end

    Macro.prewalk(node, [], fn
      # Explicit module call: Module.function(args). Also detects OTP dispatch
      # shapes (GenServer.call/cast, :gen_server.call/cast) and rewrites them
      # into an edge to the server's handle_call/handle_cast callback, carrying
      # the message arg so the clause-attribution pass can resolve the clause.
      {{:., _, [module, func]}, meta, args} = call, acc when is_list(args) ->
        case make_remote_site(module, func, args, module_name, meta[:line]) do
          {:ok, site} -> {call, [site | acc]}
          :skip -> {call, acc}
        end

      # Pipelined local call captured as dot: .function(args)
      {{:., _, [func]}, meta, args} = call, acc when is_list(args) and is_atom(func) ->
        site = %{callee: "#{func}/#{length(args)}", line: meta[:line],
                 arg_patterns: Enum.map(args, &norm_pat(&1, module_name)), dispatch: nil}
        {call, [site | acc]}

      # Bare local call: function_name(args) — resolve to module if known
      {name, meta, args} = call, acc when is_atom(name) and is_list(args) and not is_nil(module_name) ->
        name_str = to_string(name)
        cond do
          # Skip single-char atoms (operators like :e, :a)
          byte_size(name_str) <= 1 -> {call, acc}
          # Skip AST artifacts and control flow
          MapSet.member?(@kernel_functions, name) -> {call, acc}
          # Skip operators and syntax
          MapSet.member?(@skip_names, name) -> {call, acc}
          # Likely a local call (defp/def in same module) — record as Module.name/arity
          true ->
            site = %{callee: "#{module_name}.#{name}/#{length(args)}", line: meta[:line],
                     arg_patterns: Enum.map(args, &norm_pat(&1, module_name)), dispatch: nil}
            {call, [site | acc]}
        end

      call, acc ->
        {call, acc}
    end)
    |> elem(1)
    |> Enum.reject(fn site -> site.callee == self_mfa end)
    |> Enum.uniq_by(fn site -> {site.callee, site.line} end)
  end

  # A node in the "module" position of a dotted call is a real module reference
  # iff it is an alias (Mod), the atom __MODULE__, or a bare module atom (e.g.
  # :lists, :ets). Variable nodes are 3-tuples {name, meta, ctx} and fall through
  # to false, which is what we want.
  defp module_ref?({:__aliases__, _, _}), do: true
  defp module_ref?({:__MODULE__, _, _}), do: true
  defp module_ref?(:__MODULE__), do: true
  defp module_ref?(atom) when is_atom(atom), do: true
  defp module_ref?(_), do: false

  # Resolve a module-reference node to its dotted string. __MODULE__ (in either
  # AST form — bare atom or 3-tuple) resolves to the enclosing module name.
  defp resolve_module({:__aliases__, _, parts}, _) when is_list(parts),
    do: Enum.map_join(parts, ".", &to_string/1)
  defp resolve_module({:__MODULE__, _, _}, module_name), do: module_name
  defp resolve_module(:__MODULE__, module_name), do: module_name
  defp resolve_module(atom, _) when is_atom(atom), do: to_string(atom)
  defp resolve_module(other, _), do: module_to_string(other)

  # ------------------------------------------------------------------
  # Dispatch catalogue (Tier 3)
  # ------------------------------------------------------------------
  # Recognise GenServer / :gen_server call/cast and rewrite the edge to the
  # server's handle_call/handle_cast callback, carrying the message argument
  # as the first effective-arg pattern so clause attribution can resolve the
  # clause. Only rewrites when the server arg is statically resolvable to a
  # module (alias or __MODULE__); a variable or registered-name server yields
  # :skip — we'd rather drop the edge than emit noise to an unknown module.

  defp make_remote_site(module, func, args, module_name, line) do
    arity = length(args)
    cond do
      is_genserver?(module) and func == :call and arity in [2, 3] ->
        make_dispatch_site(args, :handle_call, 3, line, "GenServer.call", module_name)
      is_genserver?(module) and func == :cast and arity == 2 ->
        make_dispatch_site(args, :handle_cast, 2, line, "GenServer.cast", module_name)
      module_ref?(module) ->
        {:ok, %{callee: "#{resolve_module(module, module_name)}.#{func}/#{arity}", line: line,
                arg_patterns: Enum.map(args, &norm_pat(&1, module_name)), dispatch: nil}}
      true ->
        :skip
    end
  end

  defp is_genserver?({:__aliases__, _, [:GenServer]}), do: true
  defp is_genserver?(:gen_server), do: true
  defp is_genserver?(_), do: false

  defp make_dispatch_site(args, callback, cb_arity, line, label, module_name) do
    server_ast = Enum.at(args, 0)
    msg_ast = Enum.at(args, 1)
    case resolve_server(server_ast, module_name) do
      nil ->
        :skip
      server ->
        msg_pat = norm_pat(msg_ast, module_name)
        rest = List.duplicate(%{"t" => "any"}, cb_arity - 1)
        {:ok, %{callee: "#{server}.#{callback}/#{cb_arity}", line: line,
                arg_patterns: [msg_pat | rest], dispatch: label}}
    end
  end

  defp resolve_server({:__aliases__, _, parts}, _) when is_list(parts),
    do: Enum.map_join(parts, ".", &to_string/1)
  defp resolve_server({:__MODULE__, _, _}, module_name), do: module_name
  defp resolve_server(:__MODULE__, module_name), do: module_name
  defp resolve_server(_, _), do: nil

  # ------------------------------------------------------------------
  # Pattern normalization (term language for clause attribution)
  # ------------------------------------------------------------------
  # Produces a JSON-encodable map. The attribution pass unifies a call-site
  # arg pattern against each clause head pattern to decide which clause(s)
  # could receive the call. Unknown/complex shapes degrade to %{"t"=>"other"}
  # which conservatively unifies as :unknown (cannot rule the clause out).
  # Variable nodes are 3-tuples {name, meta, ctx} with an atom context; aliases
  # are 3-tuples whose third element is a list, so the var clause's guard
  # (is_atom(ctx)) excludes aliases.

  defp norm_pat(nil, _), do: %{"t" => "nil"}
  defp norm_pat(true, _), do: %{"t" => "lit", "v" => true}
  defp norm_pat(false, _), do: %{"t" => "lit", "v" => false}
  defp norm_pat(:__MODULE__, mod), do: %{"t" => "atom", "v" => mod || "__MODULE__"}
  defp norm_pat(atom, _) when is_atom(atom), do: %{"t" => "atom", "v" => Atom.to_string(atom)}
  defp norm_pat(n, _) when is_number(n), do: %{"t" => "num", "v" => n}
  defp norm_pat(b, _) when is_binary(b), do: %{"t" => "str", "v" => b}
  defp norm_pat({:{}, _, elems}, mod), do: %{"t" => "tuple", "e" => Enum.map(elems, &norm_pat(&1, mod))}
  defp norm_pat({a, b}, mod), do: %{"t" => "tuple", "e" => [norm_pat(a, mod), norm_pat(b, mod)]}
  defp norm_pat(list, mod) when is_list(list), do: %{"t" => "list", "e" => Enum.map(list, &norm_pat(&1, mod))}
  defp norm_pat({:%{}, _, _}, _), do: %{"t" => "other"}
  defp norm_pat({:%, _, _}, _), do: %{"t" => "other"}
  defp norm_pat({:__aliases__, _, parts}, _) when is_list(parts),
    do: %{"t" => "atom", "v" => Enum.map_join(parts, ".", &to_string/1)}
  defp norm_pat({:^, _, _}, _), do: %{"t" => "other"}
  defp norm_pat({:<<>>, _, _}, _), do: %{"t" => "other"}
  defp norm_pat({name, _, ctx}, _) when is_atom(name) and is_atom(ctx), do: %{"t" => "var"}
  defp norm_pat(_, _), do: %{"t" => "other"}

  # Unify a call-site pattern with a clause-head pattern.
  # :match = definitively could receive; :nomatch = ruled out; :unknown =
  # structurally possible but not provable (var, other, guarded).
  # Unify a CALL-SITE arg pattern (1st arg) against a CLAUSE-HEAD pattern
  # (2nd arg). Direction matters:
  #   - head var   => :match   (catch-all head accepts any call value)
  #   - call var   => :unknown (call value not statically known)
  # This is what makes a literal dispatch resolve to its clause even when a
  # later catch-all clause also structurally matches, while a variable message
  # stays correctly ambiguous.
  defp unify(_call, %{"t" => "var"}), do: :match           # head catch-all accepts any call value
  defp unify(%{"t" => "var"}, _head), do: :unknown         # call value unknown vs concrete head
  defp unify(%{"t" => "any"}, _head), do: :match            # call-side don't-care (OTP-provided args)
  defp unify(%{"t" => "other"}, _), do: :unknown
  defp unify(_, %{"t" => "other"}), do: :unknown
  defp unify(%{"t" => a}, %{"t" => b}) when a != b, do: :nomatch
  defp unify(%{"t" => "nil"}, %{"t" => "nil"}), do: :match
  defp unify(%{"t" => "lit", "v" => v}, %{"t" => "lit", "v" => v}), do: :match
  defp unify(%{"t" => "lit"}, %{"t" => "lit"}), do: :nomatch
  defp unify(%{"t" => "atom", "v" => v}, %{"t" => "atom", "v" => v}), do: :match
  defp unify(%{"t" => "atom"}, %{"t" => "atom"}), do: :nomatch
  defp unify(%{"t" => "num", "v" => v}, %{"t" => "num", "v" => v}), do: :match
  defp unify(%{"t" => "num"}, %{"t" => "num"}), do: :nomatch
  defp unify(%{"t" => "str", "v" => v}, %{"t" => "str", "v" => v}), do: :match
  defp unify(%{"t" => "str"}, %{"t" => "str"}), do: :nomatch
  defp unify(%{"t" => "tuple", "e" => e1}, %{"t" => "tuple", "e" => e2}), do: unify_seq(e1, e2)
  defp unify(%{"t" => "list", "e" => e1}, %{"t" => "list", "e" => e2}), do: unify_seq(e1, e2)
  defp unify(_, _), do: :unknown

  defp unify_seq(e1, e2) do
    if length(e1) != length(e2) do
      :nomatch
    else
      Enum.reduce_while(Enum.zip(e1, e2), :match, fn {a, b}, acc ->
        case unify(a, b) do
          :nomatch -> {:halt, :nomatch}
          :unknown -> {:cont, :unknown}
          :match -> {:cont, acc}
        end
      end)
    end
  end

  # ------------------------------------------------------------------
  # Clause attribution
  # ------------------------------------------------------------------
  # Given a call site and the global clause index, decide which clause(s) of
  # the callee could receive this call and stamp dst_clause + attribution onto
  # the edge. Degrades gracefully: unknown callee or no structural match ->
  # arity level (dst_clause nil, attribution nil), never a wrong answer.

  defp attribute_call(site, clause_index) do
    %{callee: callee, arg_patterns: arg_patterns, line: line, dispatch: dispatch} = site
    base = %{callee: callee, dst_clause: nil, attribution: nil, dispatch: dispatch, line: line}

    case parse_callee(callee) do
      {:ok, {mod, name, arity}} ->
        case Map.get(clause_index, {mod, name, arity}) do
          nil ->
            base
          clauses ->
            ordered = Enum.sort_by(clauses, &elem(&1, 0))
            results =
              Enum.map(ordered, fn {ordinal, head_pats, guarded} ->
                if length(head_pats) != length(arg_patterns) do
                  {ordinal, :nomatch}
                else
                  case unify_seq(arg_patterns, head_pats) do
                    :nomatch ->
                      {ordinal, :nomatch}
                    res ->
                      res = if guarded and res == :match, do: :unknown, else: res
                      {ordinal, res}
                  end
                end
              end)

            candidates = Enum.filter(results, fn {_, r} -> r != :nomatch end)

            case candidates do
              [] ->
                # structurally ruled out — keep arity-level edge
                base
              _ ->
                # First-match-wins at runtime: the first :match clause with no
                # preceding :unknown clause is a definite resolution; otherwise
                # an earlier guarded/unknown clause might have stolen dispatch.
                case find_definite_winner(results) do
                  {:ok, ord} ->
                    %{base | dst_clause: ord, attribution: if(dispatch, do: "dispatch", else: "direct")}
                  :ambiguous ->
                    {earliest_ord, _} = hd(candidates)
                    %{base | dst_clause: earliest_ord, attribution: "ambiguous"}
                end
            end
        end

      :error ->
        base
    end
  end

  # Scan ordered (ordinal, result) pairs; halt at the first :match (definite
  # runtime winner) or :unknown (blocks definite resolution). :nomatch clauses
  # are skipped over.
  defp find_definite_winner(results) do
    Enum.reduce_while(results, :ambiguous, fn
      {_ord, :nomatch}, acc -> {:cont, acc}
      {ord, :match}, _ -> {:halt, {:ok, ord}}
      {_ord, :unknown}, _ -> {:halt, :ambiguous}
    end)
  end

  defp parse_callee(callee) do
    case Regex.run(~r/^(.*)\.([^.\/]+)\/(\d+)$/, callee) do
      [_, mod, name, arity] -> {:ok, {mod, name, String.to_integer(arity)}}
      _ -> :error
    end
  end

  def module_to_string({:__aliases__, _, aliases}) do
    Enum.map_join(aliases, ".", &to_string/1)
  end
  def module_to_string(atom) when is_atom(atom), do: to_string(atom)
  def module_to_string(other), do: Macro.to_string(other)

  defp make_id(module, name, arity, file) do
    :crypto.hash(:sha256, "#{module}|#{name}|#{arity}|#{file}")
    |> Base.encode16(case: :lower)
  end

  def extract_body_keywords(body, limit \\ 30) do
    Macro.prewalk(body, [], fn
      atom, acc when is_atom(atom) and atom not in [nil, true, false, :do, :end, :when, :fn] ->
        {atom, [to_string(atom) | acc]}

      {name, _, context} = node, acc when is_atom(name) and is_atom(context) ->
        name_str = to_string(name)
        if name_str not in ["_", "x", "y", "opts", "state", "acc"] and not String.starts_with?(name_str, "_") do
          {node, [name_str | acc]}
        else
          {node, acc}
        end

      string, acc when is_binary(string) and byte_size(string) > 3 and byte_size(string) < 50 ->
        if String.match?(string, ~r/^[a-zA-Z_][a-zA-Z0-9_]*$/) do
          {string, [string | acc]}
        else
          {string, acc}
        end

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
    |> Enum.uniq()
    |> Enum.take(limit)
  end
end

Exporter.main(System.argv())
