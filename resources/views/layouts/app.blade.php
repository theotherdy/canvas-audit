<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Canvas Audit</title>

    {{-- 1. Bootstrap (via CDN – change to your own asset pipeline if preferred) --}}
    <link rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">

    {{-- 2. Livewire styles --}}
    @livewireStyles
</head>
<body class="bg-light">

    {{-- Main page content comes from child views --}}
    @yield('content')

    {{-- 3. Bootstrap JS bundle (optional, for dropdowns/tooltips) --}}
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>

    {{-- 4. Livewire scripts --}}
    @livewireScripts
</body>
</html>
