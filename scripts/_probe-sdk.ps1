 $root = 'E:\UserData\My Documents\ChatGPT\Browser Bridge'
 Set-Location $root
 Get-ChildItem node_modules/@modelcontextprotocol -Recurse -Filter package.json | ForEach-Object {
     $pkg = Get-Content $_.FullName -Raw | ConvertFrom-Json
     Write-Output ('=== ' + $pkg.name + '@' + $pkg.version + ' ===')
     if ($pkg.exports) { $pkg.exports | ConvertTo-Json -Depth 4 }
     Write-Output ''
 }
