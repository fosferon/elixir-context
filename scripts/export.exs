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
    safe_prewalk(body, acc, fn
      {:def, meta, [{name, _, args}, _body_list]} = node, acc when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :public)
        {node, [def_info | acc]}

      {:defp, meta, [{name, _, args}, _body_list]} = node, acc when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :private)
        {node, [def_info | acc]}

      {:defmacro, meta, [{name, _, args}, _body_list]} = node, acc when is_atom(name) ->
        def_info = extract_def_info(node, meta, name, args || [], module_name, file, :macro)
        {node, [def_info | acc]}

      node, acc ->
        {node, acc}
    end)
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

  def extract_def_info(node, meta, name, args, module_name, file, _type) do
    args_list = if is_list(args), do: args, else: []
    arity = length(args_list)
    start_line = meta[:line] || 1
    end_line = meta[:end_line] || start_line

    signature = "#{name}(#{Enum.map_join(args_list, ", ", &Macro.to_string/1)})"
    spec = nil  # TODO: extract @spec
    doc = nil   # TODO: extract @doc

    lexical_text = "#{module_name}.#{signature}"
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
      {{:., _, [module, func]}, meta, args} = call, acc when is_list(args) ->
        mfa = "#{module_to_string(module)}.#{func}/#{length(args)}"
        {call, [mfa | acc]}

      {{:., _, [func]}, meta, args} = call, acc when is_list(args) and is_atom(func) ->
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
end

Exporter.main(System.argv())