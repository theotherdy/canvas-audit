
<x-app-layout>
  <h1 class="text-xl font-semibold mb-4">Canvas Course Dashboard</h1>
  <table class="min-w-full border">
    <thead class="bg-gray-100">
      <tr><th class="p-2">Course</th><th class="p-2">Students</th>
          <th class="p-2">Pages</th><th class="p-2">Quizzes</th></tr>
    </thead>
    <tbody>
      @foreach($courses as $c)
      <tr>
        <td class="border p-2"><a class="text-blue-700 underline" href="{{route('show',$c->id)}}">{{ $c->name }}</a></td>
        <td class="border p-2 text-center">{{ $c->students }}</td>
        <td class="border p-2 text-center">{{ $c->pages_count }}</td>
        <td class="border p-2 text-center">{{ $c->quizzes_count }}</td>
      </tr>
      @endforeach
    </tbody>
  </table>
</x-app-layout>
