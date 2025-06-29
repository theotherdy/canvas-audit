<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Canvas Audit</title>
    <link rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
</head>
<body class="bg-light">
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
        <div class="container">
            <a class="navbar-brand" href="{{ route('audit.home') }}">Canvas Audit</a>
            <div class="navbar-nav ms-auto">
                <a class="nav-link" href="{{ route('debug.index') }}">Debug</a>
            </div>
        </div>
    </nav>

    @yield('content')
</body>
</html>
