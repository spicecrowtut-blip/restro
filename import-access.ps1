$ErrorActionPreference = 'Stop'

$databasePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resro.accdb'))
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
  throw "Access database not found: $databasePath"
}

$connection = New-Object System.Data.Odbc.OdbcConnection
$connection.ConnectionString = "Driver={Microsoft Access Driver (*.mdb, *.accdb)};DBQ=$databasePath;"
$temporaryPath = Join-Path $env:TEMP ("borcelle-access-{0}.json" -f [guid]::NewGuid())

try {
  $connection.Open()
  $command = $connection.CreateCommand()
  $command.CommandText = 'SELECT [Код] AS accessCode, [Поле1] AS name, [Поле2] AS price FROM [Таблица1]'
  $reader = $command.ExecuteReader()
  $rows = [System.Collections.Generic.List[object]]::new()

  while ($reader.Read()) {
    $code = if ($reader.IsDBNull(0)) { $null } else { [int]$reader.GetValue(0) }
    $name = if ($reader.IsDBNull(1)) { $null } else { [string]$reader.GetValue(1) }
    $price = if ($reader.IsDBNull(2)) { $null } else { [decimal]$reader.GetValue(2) }
    $rows.Add([pscustomobject]@{
      accessCode = $code
      name = $name
      price = $price
    })
  }

  $reader.Close()
  $connection.Close()
  $json = ConvertTo-Json -InputObject $rows.ToArray() -Depth 3
  [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))

  & node (Join-Path $PSScriptRoot 'import-access.js') $temporaryPath
  if ($LASTEXITCODE -ne 0) {
    throw "Access import failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($connection.State -eq 'Open') {
    $connection.Close()
  }
  if (Test-Path -LiteralPath $temporaryPath) {
    Remove-Item -LiteralPath $temporaryPath
  }
}
