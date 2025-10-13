#!/usr/bin/env elixir

# Elixir Context Exporter
# Scans Elixir files and outputs JSONL with function/module metadata

Application.ensure_all_started(:logger)
Logger.configure(level: :warning)
Logger.configure_backend(:console, level: :warning)

# Start applications we need
Application.ensure_all_started(:jason)

# Safely configure Mix shell if Mix is available
try do
  if Code.ensure_loaded?(Mix) do
    Mix.shell(Mix.Shell.Quiet)
  end
rescue
  _ -> :ok
end

defmodule Exporter do
  def main(args) do
    {opts, _, _} = OptionParser.parse(args, switches: [file: :string, quiet: :boolean, out: :string])
    quiet = opts[:quiet] || false
    out_path = opts[:out]

    files =
      if opts[:file] do
        [opts[:file]]
      else
        # Only scan project-specific directories, exclude deps and build artifacts
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
          String.contains?(file, "/templates/")
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

    # Deduplicate by module|name|arity - keep first occurrence (lowest line number)
    # This handles multi-clause functions which create duplicate entries
    unique_defs =
      all_defs
      |> Enum.group_by(fn def -> {def.module, def.name, def.arity} end)
      |> Enum.map(fn {_key, defs} ->
        # Keep the definition with the earliest start_line
        Enum.min_by(defs, & &1.start_line)
      end)

    # Output JSONL to file if out_path provided, else stdout
    if out_path do
      {:ok, io} = File.open(out_path, [:write, :binary])
      Enum.each(unique_defs, fn defn -> IO.binwrite(io, Jason.encode!(defn) <> "\n") end)
      File.close(io)
    else
      Enum.each(unique_defs, &IO.puts(Jason.encode!(&1)))
    end

    unless quiet do
      total = length(files)
      IO.puts(:stderr, "Total files: #{total}, Processed: #{processed}, Skipped: #{skipped}")
    end
  end

  def extract_definitions(ast, file) do
    Macro.prewalk(ast, [], fn
      {:defmodule, meta, [module, [do: body]]}, acc ->
        module_name = module_to_string(module)
        extract_from_module(body, module_name, file, meta[:line] || 1, acc)

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
  end

  def extract_from_module(body, module_name, file, _module_line, acc) do
    # Collect attributes (doc, spec) and associate with functions
    {_, {defs, _attrs}} = safe_prewalk_with_attrs(body, {[], %{}}, fn
      {:@, _, [{:doc, _, [doc_string]}]} = node, {defs, attrs} ->
        {node, {defs, Map.put(attrs, :pending_doc, doc_string)}}

      {:@, _, [{:spec, _, spec_ast}]} = node, {defs, attrs} ->
        spec_text = Macro.to_string({:spec, [], spec_ast})
        {node, {defs, Map.put(attrs, :pending_spec, spec_text)}}

      {:def, meta, [{name, _, args}, body_list]} = node, {defs, attrs} when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :public, attrs, body_list)
        {node, {[def_info | defs], %{}}}

      {:defp, meta, [{name, _, args}, body_list]} = node, {defs, attrs} when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :private, attrs, body_list)
        {node, {[def_info | defs], %{}}}

      {:defmacro, meta, [{name, _, args}, body_list]} = node, {defs, attrs} when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :macro, attrs, body_list)
        {node, {[def_info | defs], %{}}}

      node, acc ->
        {node, acc}
    end)

    {body, defs ++ acc}
  end

  def safe_prewalk(ast, acc, fun) do
    {ast, acc} = fun.(ast, acc)
    case ast do
      list when is_list(list) ->
        {list, acc} = Enum.map_reduce(list, acc, &safe_prewalk(&1, &2, fun))
        {list, acc}
      {name, meta, args} when is_list(args) ->
        {args, acc} = Enum.map_reduce(args, acc, &safe_prewalk(&1, &2, fun))
        {{name, meta, args}, acc}
      _ ->
        {ast, acc}
    end
  end

  def safe_prewalk_with_attrs(ast, acc, fun) do
    {ast, acc} = fun.(ast, acc)
    case ast do
      list when is_list(list) ->
        {list, acc} = Enum.map_reduce(list, acc, &safe_prewalk_with_attrs(&1, &2, fun))
        {list, acc}
      {name, meta, args} when is_list(args) ->
        {args, acc} = Enum.map_reduce(args, acc, &safe_prewalk_with_attrs(&1, &2, fun))
        {{name, meta, args}, acc}
      _ ->
        {ast, acc}
    end
  end

  def extract_def_info(node, meta, name, args, module_name, file, _type, attrs \\ %{}, body_list \\ nil) do
    args_list = if is_list(args), do: args, else: []
    arity = length(args_list)
    start_line = meta[:line] || 1
    end_line = meta[:end_line] || start_line

    signature = "#{name}(#{Enum.map_join(args_list, ", ", &Macro.to_string/1)})"
    spec = Map.get(attrs, :pending_spec)
    doc = Map.get(attrs, :pending_doc)

    # Extract keywords from body (atoms, important identifiers)
    body_keywords = if body_list, do: extract_body_keywords(body_list, 30), else: []

    # Build enriched lexical_text
    lexical_parts = [
      "#{module_name}.#{signature}",
      doc,
      spec,
      Enum.join(body_keywords, " ")
    ]
    lexical_text = lexical_parts |> Enum.reject(&is_nil/1) |> Enum.join(" ")

    struct_text = Macro.to_string(node)

    calls = extract_calls(node)

    # ID based on module|name|arity|file (NOT start_line) for stable identity across multi-clause functions
    id = :crypto.hash(:sha256, "#{module_name}|#{name}|#{arity}|#{file}")
         |> Base.encode16(case: :lower)

    %{
      id: id,
      module: module_name,
      name: to_string(name),
      arity: arity,
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

  def extract_calls(node) do
    Macro.prewalk(node, [], fn
      {{:., _, [module, func]}, _meta, args} = call, acc when is_list(args) ->
        mfa = "#{module_to_string(module)}.#{func}/#{length(args)}"
        {call, [mfa | acc]}

      {{:., _, [func]}, _meta, args} = call, acc when is_list(args) and is_atom(func) ->
        mfa = "#{func}/#{length(args)}"
        {call, [mfa | acc]}

      node, acc ->
        {node, acc}
    end)
    |> elem(1)
    |> Enum.uniq()
  end

  def module_to_string({:__aliases__, _, aliases}) do
    Enum.map_join(aliases, ".", &to_string/1)
  end

  def module_to_string(atom) when is_atom(atom), do: to_string(atom)
  def module_to_string(other), do: Macro.to_string(other)

  def extract_body_keywords(body, limit \\ 30) do
    # Extract important keywords from function body for better searchability
    Macro.prewalk(body, [], fn
      # Atoms (often represent important concepts like :ok, :error, :user, etc.)
      atom, acc when is_atom(atom) and atom not in [nil, true, false, :do, :end, :when, :fn] ->
        {atom, [to_string(atom) | acc]}

      # Variables in pattern matching
      {name, _, context} = node, acc when is_atom(name) and is_atom(context) ->
        name_str = to_string(name)
        # Skip common/noise variables
        if name_str not in ["_", "x", "y", "opts", "state", "acc"] and not String.starts_with?(name_str, "_") do
          {node, [name_str | acc]}
        else
          {node, acc}
        end

      # String literals (might contain important search terms)
      string, acc when is_binary(string) and byte_size(string) > 3 and byte_size(string) < 50 ->
        # Only include if alphanumeric (skip interpolations, etc.)
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