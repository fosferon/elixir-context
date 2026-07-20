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

    # Deduplicate: merge multi-clause functions (union calls, keep earliest line)
    unique_defs =
      all_defs
      |> Enum.group_by(fn def -> {def.module, def.name, def.arity, def.kind} end)
      |> Enum.map(fn {_key, defs} ->
        primary = Enum.min_by(defs, & &1.start_line)
        last = Enum.max_by(defs, & &1.end_line)
        merged_calls = defs |> Enum.flat_map(& &1.calls) |> Enum.uniq()
        %{primary | calls: merged_calls, end_line: last.end_line}
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
      calls: calls
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
      # Explicit module call: Module.function(args) — but only when the dot's
      # left side is an actual module reference. A variable dot-access like
      # `state.conn` parses as {{:., _, [{:state, _, _}, :conn]}, _, []} and is
      # NOT a function call; without this guard it was recorded as "state.conn/0".
      {{:., _, [module, func]}, _meta, args} = call, acc when is_list(args) ->
        if module_ref?(module) do
          resolved = if module == :__MODULE__, do: module_name, else: module_to_string(module)
          mfa = "#{resolved}.#{func}/#{length(args)}"
          {call, [mfa | acc]}
        else
          {call, acc}
        end

      # Pipelined local call captured as dot: .function(args)
      {{:., _, [func]}, _meta, args} = call, acc when is_list(args) and is_atom(func) ->
        mfa = "#{func}/#{length(args)}"
        {call, [mfa | acc]}

      # Bare local call: function_name(args) — resolve to module if known
      {name, _meta, args} = call, acc when is_atom(name) and is_list(args) and not is_nil(module_name) ->
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
            mfa = "#{module_name}.#{name}/#{length(args)}"
            {call, [mfa | acc]}
        end

      call, acc ->
        {call, acc}
    end)
    |> elem(1)
    |> Enum.reject(&(&1 == self_mfa))
    |> Enum.uniq()
  end

  # A node in the "module" position of a dotted call is a real module reference
  # iff it is an alias (Mod), the atom __MODULE__, or a bare module atom (e.g.
  # :lists, :ets). Variable nodes are 3-tuples {name, meta, ctx} and fall through
  # to false, which is what we want.
  defp module_ref?({:__aliases__, _, _}), do: true
  defp module_ref?(:__MODULE__), do: true
  defp module_ref?(atom) when is_atom(atom), do: true
  defp module_ref?(_), do: false

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
